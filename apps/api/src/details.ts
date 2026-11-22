import { CUSTOM_DETAIL, DETAIL_KIND_LABELS, DETAIL_KINDS, DETAIL_LIMITS, checkDetailValue, daysBetween, detailTypeFor, expiryStage, isCardField, isDay, isDetailKind, joinNames, sameDetailName, type Bot, type DetailRecord, type Thread } from "@gond/shared";
import { askApproval, expiredText, setAsideText } from "./approvals.ts";
import { hourIn } from "./check-ins.ts";
import { getPrimary } from "./data/bots.ts";
import { addDetailFields, expiringDetails, findDetail, listDetails, markReminded, readDetailFields, type ExpiringDetail } from "./data/details.ts";
import { userTimezone } from "./data/prefs.ts";
import { postMessage } from "./data/threads.ts";
import type { DriverTool } from "./driver.ts";
import { boundSite, holdLogin, pageHost, siteOnPage } from "./logins.ts";
import { todayIn } from "./souls.ts";
import { isSpace } from "./spaces.ts";

const WHERE = "Settings → Your details";
const NOT_IN_SPACES = "NOT done: the person's details stay out of spaces. If they want them used, they can ask you in your own chat.";
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function detailsText(records: DetailRecord[]): string {
  if (!records.length) return `The person has no details saved. They add them in ${WHERE}; you can save what they tell you with save_details.`;
  const lines = records.flatMap((record) => [
    `- ${record.label} (${DETAIL_KIND_LABELS[record.kind] ?? record.kind})${record.expiresOn ? ` · expires ${record.expiresOn}` : ""}`,
    ...record.fields.map((field) => `  - ${field.label}: ${field.private ? (field.saved ? "private (use_details types it)" : "private, not saved yet") : field.value || "(empty)"}`),
  ]);
  return [`The person's details (${WHERE}), saved and checked by them:`, ...lines, "Use the readable ones as they are. A private one is typed into a web form only with use_details and a type_login action; you never see it, and you never ask for it in a sentence."].join("\n");
}

export function detailTypeName(record: string, field: string, taken: Set<string>): string {
  const slug = (part: string) => part.toUpperCase().replace(/['’]S\b/g, "S").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  let base = [slug(record), slug(field)].filter(Boolean).join("_").slice(0, 56).replace(/_+$/, "") || "DETAIL";
  if (!/^[A-Z]/.test(base) || isCardField(base)) base = `DETAIL_${base}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

type Wanted = { record: string; fields: string[] };

function wantedOf(raw: unknown): Wanted[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "name the details: a list of {record, fields}, from list_details" };
  const out: Wanted[] = [];
  for (const item of raw) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const record = text(entry.record, 80);
    const fields = Array.isArray(entry.fields) ? entry.fields.map((f) => text(f, 60)).filter(Boolean) : [];
    if (!record || !fields.length) return { error: "each item needs a record and the fields to type from it" };
    out.push({ record, fields });
  }
  if (out.reduce((n, w) => n + w.fields.length, 0) > DETAIL_LIMITS.fields) return { error: `ask for ${DETAIL_LIMITS.fields} details at most at a time` };
  return out;
}

export function detailsTools(context: { bot: Bot; thread: Thread; signal?: AbortSignal; computer: boolean }): Record<string, DriverTool> {
  const { bot, thread, signal } = context;
  const tools: Record<string, DriverTool> = {
    list_details: {
      description: `The person's details from ${WHERE}: the people in their household, IDs and documents, insurance and vehicles, as they saved them. Readable ones come with their values; private ones (an ID's number, an insurance member ID) only by name, for use_details.`,
      inputSchema: schema({}),
      execute: async () => (isSpace(thread) ? NOT_IN_SPACES : detailsText(listDetails(bot.userId))),
    },
    save_details: {
      description: `Save something the person told you about their household to ${WHERE}, so every bot of theirs can use it: a name, a date of birth, an address, allergies, a school, a plate. The person says yes on a card first. Never a private number (an ID, a passport, an insurance or account number): tell them to add it there themselves, marked private.`,
      inputSchema: schema(
        {
          record: { type: "string", description: "Whose or what it is, as list_details names it, like Maya or Maya's passport; a new name makes a new record." },
          kind: { type: "string", enum: [...DETAIL_KINDS], description: "For a new record: what it is." },
          fields: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"], additionalProperties: false }, description: "The details, like {label: 'Date of birth', value: '2018-03-03'}; a date as YYYY-MM-DD." },
          expires_on: { type: "string", description: "When it runs out, YYYY-MM-DD, for a document or a policy." },
        },
        ["record", "fields"],
      ),
      execute: async (input) => {
        if (isSpace(thread)) return NOT_IN_SPACES;
        const record = text(input.record, DETAIL_LIMITS.label);
        if (!record) return "NOT saved: say whose or what these details are, like Maya.";
        const kind = isDetailKind(input.kind) ? input.kind : findDetail(bot.userId, record)?.kind ?? "other";
        const expiresOn = text(input.expires_on, 10) || null;
        if (expiresOn && !isDay(expiresOn)) return "NOT saved: expires_on is a day, YYYY-MM-DD.";
        // A detail Gond knows (a date of birth, an email, a phone) goes in under its own name and is checked as one.
        const fields: { type: string; label: string; value: string }[] = [];
        for (const item of Array.isArray(input.fields) ? input.fields : []) {
          const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const named = text(entry.label, DETAIL_LIMITS.fieldLabel);
          const given = text(entry.value, DETAIL_LIMITS.value + 1);
          if (!named || !given) continue;
          if (given.length > DETAIL_LIMITS.value) return `NOT saved: keep each value under ${DETAIL_LIMITS.value} characters.`;
          const known = detailTypeFor(named);
          const checked = checkDetailValue(known?.input ?? "text", given);
          if ("error" in checked) return `NOT saved: ${named} "${given}" isn't right. ${checked.error}${known?.input === "date" ? " Give it as YYYY-MM-DD." : ""}`;
          fields.push({ type: known?.id ?? CUSTOM_DETAIL, label: known?.label ?? named, value: checked.value });
        }
        if (!fields.length && !expiresOn) return "NOT saved: give at least one detail, a label and its value.";
        const answer = await askApproval({
          bot,
          threadId: thread.id,
          tool: "save_details",
          input: { record, kind, fields, ...(expiresOn ? { expires_on: expiresOn } : {}) },
          summary: `Save ${record} to your details`,
          signal,
        });
        if (answer.aside) return setAsideText(`to save ${record}`);
        if (answer.decision === "expired") return expiredText(`to save ${record}`);
        if (answer.decision !== "allow" && answer.decision !== "always") return `The person chose not to save that to ${record}. Leave it out.`;
        const saved = addDetailFields(bot.userId, record, kind, fields, expiresOn);
        if ("error" in saved) return `NOT saved: ${saved.error}.`;
        return `Saved to ${saved.label} in ${WHERE}. Every bot of the person's can read it with list_details.`;
      },
    },
    use_details: {
      description:
        "Fill in a web form with the person's saved details, private ones included, without seeing them: a camp or school sign-up, a clinic's intake, an insurance claim, a booking. Open the form in the browser first and call this on that page: it posts one card naming that site and exactly which details, and on the person's yes each is ready for 30 minutes, typed only on that site. Then fill each field with a browser type_login action by the name this returns.",
      inputSchema: schema(
        {
          site: { type: "string", description: "The site as the person knows it, like Camp Oak or campoak.org." },
          details: {
            type: "array",
            description: "Which details, by record and field names from list_details, like [{record: \"Maya\", fields: [\"Full name\", \"Date of birth\"]}, {record: \"Health insurance\", fields: [\"Member ID\"]}].",
            items: { type: "object", properties: { record: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["record", "fields"], additionalProperties: false },
          },
          reason: { type: "string", description: "What the form is, in one line, like 'Maya's summer camp sign-up'." },
        },
        ["site", "details"],
      ),
      execute: async (input) => {
        if (isSpace(thread)) return NOT_IN_SPACES;
        const site = text(input.site, 80);
        if (!site) return "NOT asked: name the site the form is on.";
        const wanted = wantedOf(input.details);
        if ("error" in wanted) return `NOT asked: ${wanted.error}.`;
        const records = listDetails(bot.userId);
        const picked: { record: DetailRecord; field: DetailRecord["fields"][number] }[] = [];
        const unknown: string[] = [];
        for (const want of wanted) {
          const record = records.find((r) => r.id === want.record) ?? records.find((r) => sameDetailName(r.label, want.record));
          if (!record) {
            unknown.push(`no record "${want.record}"`);
            continue;
          }
          for (const name of want.fields) {
            const field = record.fields.find((f) => f.id === name) ?? record.fields.find((f) => sameDetailName(f.label, name));
            if (!field) unknown.push(`${record.label} has no "${name}" (it has ${joinNames(record.fields.map((f) => f.label))})`);
            else if (!picked.some((p) => p.field.id === field.id)) picked.push({ record, field });
          }
        }
        if (unknown.length) return `NOT asked: ${unknown.join("; ")}. list_details shows what is saved.`;
        const empty = picked.filter((p) => !p.field.saved);
        const ready = picked.filter((p) => p.field.saved);
        if (!ready.length) return `NOT asked: none of those are saved yet (${joinNames(empty.map((p) => `${p.record.label}: ${p.field.label}`))}). Ask the person to add them in ${WHERE}.`;
        // The card names the page the bot has open, and the details are held to that site alone.
        const shown = siteOnPage(site, pageHost(bot.id));
        const bound = boundSite(shown);
        if (!bound) return "NOT asked: open the form's page in the browser first, then call use_details there. Details are typed only on the site the card names.";
        const groups = [...new Set(ready.map((p) => p.record.id))].map((id) => {
          const items = ready.filter((p) => p.record.id === id);
          return { label: items[0]!.record.label, value: joinNames(items.map((p) => p.field.label)) };
        });
        const reason = text(input.reason, 200);
        const answer = await askApproval({
          bot,
          threadId: thread.id,
          tool: "use_details",
          input: { site: shown, details: groups, ...(reason ? { reason } : {}) },
          summary: `Fill in details from ${joinNames(groups.map((g) => g.label))} on ${shown}`,
          signal,
        });
        if (answer.aside) return setAsideText(`to fill in details on ${shown}`);
        if (answer.decision === "expired") return expiredText(`to fill in details on ${shown}`);
        if (answer.decision !== "allow") return `The person chose not to fill in their details on ${shown}. Say what you can do without them.`;
        const taken = new Set<string>();
        const names: string[] = [];
        for (const { record, field } of ready) {
          const value = readDetailFields(bot.userId, record.id)?.find((f) => f.id === field.id)?.value;
          if (!value) continue;
          const name = detailTypeName(record.label, field.label, taken);
          holdLogin(thread.id, name, value, { site: bound });
          names.push(`${name} (${record.label}: ${field.label})`);
        }
        const missing = empty.length ? ` Not saved, so ask the person or leave them blank: ${joinNames(empty.map((p) => `${p.record.label}: ${p.field.label}`))}.` : "";
        return `The person said yes. Ready for 30 minutes, typed only on ${bound}: ${names.join(", ")}. Fill each field with a browser type_login action, {ref, name}, adding select: true for a dropdown. You never see them; never read them back off the screen or repeat them.${missing} Before the form is sent, show the person the filled page with send_screenshot and ask_approval to send it.`;
      },
    },
  };
  if (!context.computer) delete tools.use_details;
  return tools;
}

function whenText(left: number): string {
  if (left > 1) return `in ${left} days`;
  if (left === 1) return "tomorrow";
  if (left === 0) return "today";
  return left === -1 ? "yesterday" : `${-left} days ago`;
}

// Reminders come in the daytime where the person is, never in the night.
const DAY_FROM = 9;
const DAY_TO = 20;

export function expiryPrompt(items: { label: string; kind: string; expiresOn: string; left: number }[]): string {
  const lines = items.map((item) => `- ${item.label} (${DETAIL_KIND_LABELS[item.kind as keyof typeof DETAIL_KIND_LABELS] ?? item.kind}): ${item.left < 0 ? "ran out" : "runs out"} on ${item.expiresOn}, ${whenText(item.left)}.`);
  return [
    `From the person's details (${WHERE}), ${items.length === 1 ? "something runs" : "some things run"} out soon:`,
    ...lines,
    "Tell the person in a line or two, plainly, and offer the one next step you could take for them (find out how to renew it and what it needs, start the form, or remind them nearer the day), ending with ::choices. Once they've renewed it, the new date goes in their details: save_details with expires_on, or they change it there.",
  ].join("\n");
}

/**
 * From the dispatcher's minute: a record whose expiry reaches a reminder (90, 30 and 7 days before, and
 * the day itself, by the person's own date) has the primary bot tell them, in the daytime, once per
 * reminder. Each is marked before its prompt is posted, so a restart never says it twice.
 */
export function runDetailReminders(now = new Date()): number {
  const until = new Date(now.getTime() + 92 * 86_400_000).toISOString().slice(0, 10);
  const byPerson = new Map<string, { item: ExpiringDetail; stage: number; left: number }[]>();
  for (const item of expiringDetails(until)) {
    const timezone = userTimezone(item.userId);
    const today = todayIn(timezone, now);
    const stage = expiryStage(item.expiresOn, today);
    if (stage === null || (item.reminded !== null && item.reminded <= stage)) continue;
    const hour = hourIn(timezone, now);
    if (hour < DAY_FROM || hour >= DAY_TO) continue;
    byPerson.set(item.userId, [...(byPerson.get(item.userId) ?? []), { item, stage, left: daysBetween(today, item.expiresOn) }]);
  }
  let posted = 0;
  for (const [userId, due] of byPerson) {
    const bot = getPrimary(userId);
    if (!bot || bot.hidden) continue;
    const marked = due.filter(({ item, stage }) => markReminded(item.id, item.expiresOn, stage));
    if (!marked.length) continue;
    postMessage({ threadId: bot.threadId, author: "system", kind: "prompt", body: expiryPrompt(marked.map(({ item, left }) => ({ label: item.label, kind: item.kind, expiresOn: item.expiresOn, left }))) });
    posted += 1;
  }
  return posted;
}
