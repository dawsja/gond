import { HOUSEHOLD_NAME_MAX, KEY_PROVIDER_KINDS, MODEL_ID_PATTERN, isSpaceLevel, type KeyProviderKind, type MembersAi } from "@gond/shared";
import { Hono, type Context, type Next } from "hono";
import { admin, personId, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { getBot } from "../data/bots.ts";
import { askMember, createHousehold, deleteHousehold, errandThreadOf, getHousehold, joinMember, membersOf, membershipOf, removeMember, removeShare, setShare, shareOf, updateHousehold } from "../data/households.ts";
import { postMessage } from "../data/threads.ts";
import { getUser, listUsers } from "../data/users.ts";
import { emit } from "../events.ts";
import { everyoneIn, headsBots, householdChanged, householdOfPerson, householdSetup, householdView, isHeadsBot, memberHousehold } from "../households.ts";
import { profileIds } from "../data/profiles.ts";
import { sendPush } from "../push.ts";

/** A household member's AI is the household's: what would change their own answers that it's set by the head. */
export async function refuseForMembers(c: Context<Env>, next: Next) {
  const household = memberHousehold(userId(c));
  if (household) return c.json({ error: `${getUser(household.headId)?.name ?? "The head of your household"} sets the AI for your household, so this can't be changed here` }, 409);
  await next();
}

function readAi(value: unknown): MembersAi | null {
  if (!value || typeof value !== "object") return null;
  const { engine, provider, model } = value as Record<string, unknown>;
  if (engine !== "api" && engine !== "claude") return null;
  if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model.trim())) return null;
  if (engine === "claude") return { engine, provider: "anthropic", model: model.trim() };
  if (typeof provider !== "string" || !(KEY_PROVIDER_KINDS as readonly string[]).includes(provider)) return null;
  return { engine, provider: provider as KeyProviderKind, model: model.trim() };
}

function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, HOUSEHOLD_NAME_MAX);
  return name || null;
}

/** People who could be asked to join: everyone from the OIDC provider who isn't the head or in the household already. */
function candidates(headId: string) {
  return listUsers()
    .filter((user) => user.role !== "admin" && user.id !== headId && user.provider === "oidc" && !membershipOf(user.id))
    .map((user) => ({ id: user.id, name: user.name, email: user.email, image: user.avatar }));
}

export function householdsRoutes() {
  const app = new Hono<Env>();

  app.get("/household", (c) => {
    const person = personId(c);
    const household = householdView(person);
    if (!household) return c.json({ household: null, setup: admin(c) && !getHousehold() ? householdSetup(person) : null });
    if (household.role !== "head") return c.json({ household });
    const row = getHousehold()!;
    const bots = headsBots(row).map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, color: bot.color, expression: bot.expression, shape: bot.shape, avatar: bot.avatar }));
    return c.json({ household, candidates: candidates(person), bots, keys: householdSetup(person).keys });
  });

  app.post("/household", async (c) => {
    if (!admin(c)) return c.json({ error: "Only the admin can turn on Household" }, 403);
    if (getHousehold()) return c.json({ error: "There's a household already" }, 409);
    const person = personId(c);
    const setup = householdSetup(person);
    if (!setup.oidc) return c.json({ error: "Set up a sign-in provider first, under Settings → Sign-in" }, 409);
    if (!setup.linked) return c.json({ error: "Link your account to your sign-in provider first, under Settings → Account" }, 409);
    if (!setup.keys.length) return c.json({ error: "Add an API key for your household first, under Settings → AI" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = readName(body.name) ?? `${getUser(person)?.name?.split(/\s+/).at(-1) ?? "My"} household`;
    createHousehold(person, name, { engine: "api", provider: setup.keys[0]!, model: "" });
    householdChanged([person]);
    return c.json({ household: householdView(person) }, 201);
  });

  const asHead = (c: Context<Env>) => {
    const found = householdOfPerson(personId(c));
    return found?.role === "head" ? found.household : null;
  };

  app.patch("/household", async (c) => {
    const household = asHead(c);
    if (!household) return c.json({ error: "Only the head of the household can change it" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; ai?: unknown };
    const name = body.name === undefined ? undefined : readName(body.name);
    if (name === null) return c.json({ error: "Give the household a name" }, 400);
    const ai = body.ai === undefined ? undefined : readAi(body.ai);
    if (ai === null) return c.json({ error: "Pick a key and a model for your household" }, 400);
    updateHousehold(household.id, { name, ai });
    const people = everyoneIn(household);
    householdChanged(people);
    if (ai) for (const person of people) for (const id of profileIds(person)) emit({ topic: "ai", userId: id });
    return c.json({ household: householdView(personId(c)) });
  });

  app.delete("/household", (c) => {
    const household = asHead(c);
    if (!household) return c.json({ error: "Only the head of the household can end it" }, 403);
    const people = everyoneIn(household);
    deleteHousehold(household.id);
    householdChanged(people);
    return c.body(null, 204);
  });

  app.post("/household/members", async (c) => {
    const household = asHead(c);
    if (!household) return c.json({ error: "Only the head of the household can add people" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { personId?: unknown };
    const person = candidates(household.headId).find((p) => p.id === body.personId);
    if (!person) return c.json({ error: "Couldn't find that person. They need to sign in to Gond once first" }, 404);
    askMember(household.id, person.id);
    const head = getUser(household.headId)?.name ?? "Someone";
    void sendPush({ title: `${head} asked you to join ${household.name}`, body: "Open Settings → Household to join.", url: "/app/settings/household", tag: `household-${household.id}`, threadId: "" }, person.id);
    householdChanged([household.headId, person.id]);
    return c.json({ household: householdView(household.headId) }, 201);
  });

  app.delete("/household/members/:id", (c) => {
    const household = asHead(c);
    if (!household) return c.json({ error: "Only the head of the household can remove people" }, 403);
    const id = c.req.param("id");
    if (!membersOf(household.id).some((m) => m.personId === id)) return c.json({ error: "Couldn't find that person in your household" }, 404);
    removeMember(id);
    householdChanged([household.headId, id]);
    for (const profile of profileIds(id)) emit({ topic: "ai", userId: profile });
    return c.json({ household: householdView(household.headId) });
  });

  app.post("/household/join", (c) => {
    const person = personId(c);
    const found = householdOfPerson(person);
    if (found?.role !== "asked") return c.json({ error: "There's no household waiting for you to join" }, 404);
    joinMember(person);
    householdChanged(everyoneIn(found.household));
    for (const profile of profileIds(person)) emit({ topic: "ai", userId: profile });
    return c.json({ household: householdView(person) });
  });

  app.post("/household/leave", (c) => {
    const person = personId(c);
    const found = householdOfPerson(person);
    if (!found || found.role === "head") return c.json({ error: found ? "The head can't leave; end the household instead" : "You aren't in a household" }, found ? 400 : 404);
    removeMember(person);
    householdChanged([found.household.headId, person]);
    for (const profile of profileIds(person)) emit({ topic: "ai", userId: profile });
    return c.body(null, 204);
  });

  app.put("/household/shares/:botId", async (c) => {
    const household = asHead(c);
    if (!household) return c.json({ error: "Only the head of the household can share bots" }, 403);
    const bot = getBot(c.req.param("botId"));
    if (!bot || !isHeadsBot(bot, household)) return c.json({ error: "Couldn't find that bot" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { memberId?: unknown; level?: unknown; memory?: unknown; confirmed?: unknown };
    const member = membersOf(household.id).find((m) => m.personId === body.memberId && m.status === "joined");
    if (!member) return c.json({ error: "Couldn't find that person in your household" }, 404);
    const before = shareOf(bot.id, member.personId);
    const memberName = getUser(member.personId)?.name ?? "them";
    const line = (body: string) => {
      const thread = errandThreadOf(bot.id, member.personId);
      if (thread) postMessage({ threadId: thread, author: "system", kind: "event", body, answered: true });
    };
    if (body.level === null) {
      removeShare(bot.id, member.personId);
      if (before) line(`You stopped sharing ${bot.name} with ${memberName}.`);
    } else {
      if (!isSpaceLevel(body.level) || typeof body.memory !== "boolean") return c.json({ error: "Pick what their bots may have it do" }, 400);
      // Always allow lets a member's bots have the head's bot act with the head's sign-ins and no card first,
      // so it is only ever set on purpose: the page confirms it, and says so here, so nothing sets it quietly.
      if (body.level === "full" && before?.level !== "full" && body.confirmed !== true) return c.json({ error: "Confirm Always allow before turning it on" }, 400);
      setShare({ botId: bot.id, memberId: member.personId, level: body.level, memory: body.memory });
      if (body.level === "full" && before?.level !== "full") line(`You set ${bot.name} to Always allow for ${memberName}'s bots: it does what they ask, with no card to you first.`);
      else if (before?.level === "full" && body.level !== "full") line(`${bot.name} is off Always allow for ${memberName}'s bots.`);
    }
    householdChanged([household.headId, member.personId]);
    return c.json({ household: householdView(household.headId) });
  });

  return app;
}
