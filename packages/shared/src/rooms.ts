export const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9_-]{0,39})/gi;

export function mentionsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) seen.add(match[1]!.toLowerCase());
  return [...seen];
}

export function handleOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}

type RoomMember = { id: string; name: string; primary: boolean };
type RoomLine = { author: string; kind: string; body: string; sentTo?: string[] | null };

/** Who answers a room when nothing says otherwise: the primary bot if it's there, else the first bot. */
export function roomAnswerer<B extends RoomMember>(members: B[]): B | null {
  return members.find((b) => b.primary) ?? members[0] ?? null;
}

/**
 * How many bots a room holds: two at least, since one is a 1:1, and six at most, past which it is slow
 * (only `TURNS_PER_PERSON` of a person's bots answer at once) and too noisy to follow.
 */
export const ROOM_MIN_BOTS = 2;
export const ROOM_MAX_BOTS = 6;

/** A room's name when the person gives it none: its bots, the one that answers first in front ("Pip, Net and Patch", "Pip, Net, Patch and 4 more"). */
export function roomNameFor(members: RoomMember[]): string {
  const first = roomAnswerer(members);
  const names = (first ? [first, ...members.filter((b) => b !== first)] : members).map((b) => b.name);
  if (names.length <= 1) return names[0] ?? "Room";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

// Words that speak to the whole room wherever they stand.
const PLURAL_YOU = /\b(?:all of you|each of you|every one of you|y'?all|you all|you guys)\b/i;
// "everyone" speaks to the room unless it is what a verb or a preposition acts on: "tell everyone", "for everyone".
const EVERYONE = /(?<!\b(?:tell|inform|notify|message|ping|remind|update|let|show|ask|thank|give|send|cc|for|to|with|from|about|on|of)\s+)\b(?:everyone|everybody)\b/i;
// "all", "guys", "team" and the like only as a greeting or a sign-off: "Hey all!", "howdy guys", "thanks guys", "status, team?".
const GREETING = "hey|hi|hiya|heya|hello|howdy|yo|sup|ok|okay|so|alright|cool|great|awesome|nice|thanks|thank you|thx|ty|morning|good morning|afternoon|good afternoon|evening|good evening|night|good night";
const GROUP = "all|guys|team|folks|gang|crew|fellas|bots";
const VOCATIVE = new RegExp(`^\\s*(?:(?:${GREETING})[\\s,!.]+)*(?:${GROUP})\\b|,\\s*(?:${GROUP})\\s*[?.!]*\\s*$`, "i");
// A group word that ends the line speaks to it too, comma or not ("ily guys", "thanks team!"), unless
// it is what the line acts on ("ask the team", "restart the bots"). Never "all": "that's all" names nobody.
const SIGN_OFF = /(?<!\b(?:the|my|our|your|a|this|that|to|for|with|tell|ask|ping|message|restart|stop|check)\s+)\b(?:guys|team|folks|gang|crew|fellas|bots|everyone|everybody)\s*[?.!]*\s*$/i;
const BOTH = /\b(?:both|you two)\b/i;

/** The members a line names, by @handle or by name as a word in any case ("Patch, are you…", or "patch" as voice types it). */
function namedIn<B extends RoomMember>(text: string, members: B[]): B[] {
  const handles = mentionsIn(text);
  return members.filter((b) => handles.includes(handleOf(b.name)) || new RegExp(`(?<![\\w@])${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(text));
}

/**
 * The members a person's message in a room speaks to: those it names, or the room as a whole
 * ("everyone, …", "you guys", "each of you", "hey all", or "both" in a room of two). "Tell
 * everyone" is about the room, not to it.
 */
export function addressedIn<B extends RoomMember>(text: string, members: B[]): B[] {
  const handles = mentionsIn(text);
  if (handles.includes("everyone") || handles.includes("all") || PLURAL_YOU.test(text) || EVERYONE.test(text) || VOCATIVE.test(text) || SIGN_OFF.test(text) || (members.length === 2 && BOTH.test(text))) return members;
  return namedIn(text, members);
}

/**
 * Who a person's message in a room is for: whoever it names; else whom the person's own last line
 * named, since that is who they are talking to even when others joined in since; else, while bots
 * are still answering, them and those that answered since the person last wrote (`working`, bot
 * ids), so the line reaches the exchange in flight; else the one bot that spoke last; else whom an
 * earlier line of theirs addressed; else `roomAnswerer`, the primary bot when it is there. With
 * nobody named, one bot answers, never the room. `before` is the room's messages before this one,
 * oldest first.
 */
export function roomTargets<B extends RoomMember>(body: string, members: B[], before: RoomLine[], working: readonly string[] = []): B[] {
  const named = addressedIn(body, members);
  if (named.length) return named;
  const previous = before.findLast((line) => line.kind === "message" && line.author === "you");
  // Only bots named by name, or picked by the router, carry over: a line to the whole room hands on to whoever answered it.
  const routed = previous?.sentTo ? members.filter((b) => previous.sentTo!.includes(b.id)) : [];
  if (routed.length) return routed;
  const talkingTo = previous ? namedIn(previous.body, members) : [];
  if (talkingTo.length && addressedIn(previous!.body, members).length === talkingTo.length) return talkingTo;
  const busy = members.filter((b) => working.includes(b.id));
  const answered: B[] = [];
  const next = () => (busy.length ? [...answered, ...busy.filter((b) => !answered.includes(b))] : answered.slice(-1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const line = before[i]!;
    if (line.kind !== "message") continue;
    const member = members.find((b) => b.id === line.author);
    if (member) {
      if (!answered.includes(member)) answered.unshift(member);
      continue;
    }
    if (line.author !== "you") continue;
    if (next().length) return next();
    const earlier = addressedIn(line.body, members);
    if (earlier.length) return earlier;
  }
  if (next().length) return next();
  const answerer = roomAnswerer(members);
  return answerer ? [answerer] : [];
}

// "stop", "cancel that", "ok quit", "never mind": a short message that is
// only a stop. Anything with more to it ("cancel the order") is an
// instruction for the bot instead.
const STOP_REQUEST = /^(?:(?:please|pls|ok|okay|hey|no|wait|just)[\s,.!]+)*(?:stop|cancel|quit|halt|abort|never ?mind|nvm)(?:[\s,]+(?:it|that|this|now|everything|all|working|please|for now|right now|what you'?re doing))*[\s.!]*$/i;

export function isStopRequest(body: string): boolean {
  const text = body.trim();
  return text.length > 0 && text.length <= 60 && STOP_REQUEST.test(text);
}

// "thank you!", "I will", "perfect, thanks", "that will be all", "👍": a short
// message that closes the exchange rather than asking for anything.
const CLOSING_PHRASE = String.raw`(?:thanks?(?: you)?(?: (?:so|very) much| a lot| again| a ton)?|ty(?:sm)?|thx|tysm|cheers|much appreciated|appreciate (?:it|you|that)|perfect|great|awesome|amazing|nice|cool|sweet|lovely|love (?:it|that)|sounds good|looks good|all good|ok(?:ay)?|k|kk|got it|understood|will do|i will|i'?ll do (?:it|that)|i'?m good|we'?re good|that'?s (?:all|it|perfect|great)|that will be all|that'?ll be all|nothing else|no(?:pe)?,? that'?s (?:all|it)|bye|goodbye|good ?night|night|see (?:you|ya)|have a good (?:one|day|night)|you too|you'?re the best)`;
const CLOSING = new RegExp(String.raw`^(?:${CLOSING_PHRASE}(?:[\s,.!]+(?:[a-z]+))?[\s,.!]*)+$`, "i");

export function isClosing(body: string): boolean {
  const text = body
    .trim()
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[^\p{L}\p{N}'\s,.!]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return body.trim().length > 0 && body.trim().length <= 12;
  return text.length <= 60 && text.split(" ").length <= 9 && CLOSING.test(text);
}
