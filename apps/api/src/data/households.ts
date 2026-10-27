import { KEY_PROVIDER_KINDS, isSpaceLevel, type KeyProviderKind, type MembersAi, type SpaceLevel } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { newId, now } from "../ids.ts";
import { createRoom, getThread } from "./threads.ts";
import type { Thread } from "@gond/shared";

export type HouseholdRow = { id: string; name: string; headId: string; ai: MembersAi; createdAt: string };
export type MembershipRow = { householdId: string; personId: string; status: "asked" | "joined"; askedAt: string; joinedAt: string | null };
export type ShareRow = { botId: string; memberId: string; level: SpaceLevel; memory: boolean };
export type ErrandStatus = "open" | "done" | "denied" | "cancelled" | "failed";
export type ErrandRow = {
  id: string;
  botId: string;
  memberId: string;
  fromBotId: string;
  fromThreadId: string;
  errandThreadId: string;
  request: string;
  level: SpaceLevel;
  status: ErrandStatus;
  promptId: string | null;
  answer: string | null;
  createdAt: string;
};

type Row = { id: string; name: string; head_id: string; members_ai: string; created_at: string };

function isKeyKind(value: unknown): value is KeyProviderKind {
  return typeof value === "string" && (KEY_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The members' AI as stored, read loosely: anything off falls back to the API on Anthropic's key with no model yet. */
export function readMembersAi(json: string): MembersAi {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    /* the default below */
  }
  const engine = stored.engine === "claude" ? "claude" : "api";
  const provider = engine === "claude" ? "anthropic" : isKeyKind(stored.provider) ? stored.provider : "anthropic";
  return { engine, provider, model: typeof stored.model === "string" ? stored.model.slice(0, 200) : "" };
}

function toHousehold(row: Row): HouseholdRow {
  return { id: row.id, name: row.name, headId: row.head_id, ai: readMembersAi(row.members_ai), createdAt: row.created_at };
}

/** The install's one household, if the admin turned it on. */
export function getHousehold(): HouseholdRow | null {
  const row = ensureDatabase().query("SELECT * FROM gond_households ORDER BY created_at LIMIT 1").get() as Row | null;
  return row ? toHousehold(row) : null;
}

export function createHousehold(headId: string, name: string, ai: MembersAi): HouseholdRow {
  const id = newId("home");
  ensureDatabase().query("INSERT INTO gond_households (id, name, head_id, members_ai, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, headId, JSON.stringify(ai), now());
  return getHousehold()!;
}

export function updateHousehold(id: string, patch: { name?: string; ai?: MembersAi }): HouseholdRow | null {
  const db = ensureDatabase();
  if (patch.name !== undefined) db.query("UPDATE gond_households SET name = ? WHERE id = ?").run(patch.name, id);
  if (patch.ai) db.query("UPDATE gond_households SET members_ai = ? WHERE id = ?").run(JSON.stringify(patch.ai), id);
  return getHousehold();
}

/** Ends the household: its members go back to their own AI, and every share with them goes. */
export function deleteHousehold(id: string): string[] {
  return transaction((db) => {
    const people = (db.query("SELECT person_id FROM gond_household_members WHERE household_id = ?").all(id) as { person_id: string }[]).map((r) => r.person_id);
    for (const person of people) db.query("DELETE FROM gond_household_shares WHERE member_id = ?").run(person);
    db.query("DELETE FROM gond_household_members WHERE household_id = ?").run(id);
    db.query("DELETE FROM gond_households WHERE id = ?").run(id);
    return people;
  });
}

type MemberRowRaw = { household_id: string; person_id: string; status: "asked" | "joined"; asked_at: string; joined_at: string | null };

function toMembership(row: MemberRowRaw): MembershipRow {
  return { householdId: row.household_id, personId: row.person_id, status: row.status, askedAt: row.asked_at, joinedAt: row.joined_at };
}

export function membershipOf(personId: string): MembershipRow | null {
  const row = ensureDatabase().query("SELECT * FROM gond_household_members WHERE person_id = ?").get(personId) as MemberRowRaw | null;
  return row ? toMembership(row) : null;
}

export function membersOf(householdId: string): MembershipRow[] {
  return (ensureDatabase().query("SELECT * FROM gond_household_members WHERE household_id = ? ORDER BY asked_at, rowid").all(householdId) as MemberRowRaw[]).map(toMembership);
}

export function askMember(householdId: string, personId: string): MembershipRow {
  ensureDatabase().query("INSERT INTO gond_household_members (household_id, person_id, status, asked_at) VALUES (?, ?, 'asked', ?) ON CONFLICT (person_id) DO NOTHING").run(householdId, personId, now());
  return membershipOf(personId)!;
}

export function joinMember(personId: string): MembershipRow | null {
  ensureDatabase().query("UPDATE gond_household_members SET status = 'joined', joined_at = ? WHERE person_id = ? AND status = 'asked'").run(now(), personId);
  return membershipOf(personId);
}

/** Takes a person out of the household, or back the ask; every share with them goes too. */
export function removeMember(personId: string): boolean {
  return transaction((db) => {
    db.query("DELETE FROM gond_household_shares WHERE member_id = ?").run(personId);
    return db.query("DELETE FROM gond_household_members WHERE person_id = ?").run(personId).changes > 0;
  });
}

type ShareRaw = { bot_id: string; member_id: string; level: string; memory: number };

function toShare(row: ShareRaw): ShareRow | null {
  return isSpaceLevel(row.level) ? { botId: row.bot_id, memberId: row.member_id, level: row.level, memory: Boolean(row.memory) } : null;
}

export function listShares(): ShareRow[] {
  return (ensureDatabase().query("SELECT * FROM gond_household_shares ORDER BY set_at").all() as ShareRaw[]).flatMap((r) => toShare(r) ?? []);
}

export function sharesWith(memberId: string): ShareRow[] {
  return listShares().filter((share) => share.memberId === memberId);
}

export function shareOf(botId: string, memberId: string): ShareRow | null {
  const row = ensureDatabase().query("SELECT * FROM gond_household_shares WHERE bot_id = ? AND member_id = ?").get(botId, memberId) as ShareRaw | null;
  return row ? toShare(row) : null;
}

export function setShare(share: ShareRow): void {
  ensureDatabase()
    .query("INSERT INTO gond_household_shares (bot_id, member_id, level, memory, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bot_id, member_id) DO UPDATE SET level = excluded.level, memory = excluded.memory, set_at = excluded.set_at")
    .run(share.botId, share.memberId, share.level, share.memory ? 1 : 0, now());
}

export function removeShare(botId: string, memberId: string): boolean {
  return ensureDatabase().query("DELETE FROM gond_household_shares WHERE bot_id = ? AND member_id = ?").run(botId, memberId).changes > 0;
}

export function errandThreadOf(botId: string, memberId: string): string | null {
  const row = ensureDatabase().query("SELECT id FROM gond_threads WHERE errand_bot = ? AND errand_for = ?").get(botId, memberId) as { id: string } | null;
  return row?.id ?? null;
}

/** The head's conversation where one shared bot does one member's errands: made the first time it's needed. */
export function errandThreadFor(botId: string, botName: string, ownerId: string, memberId: string, memberName: string): Thread {
  const found = errandThreadOf(botId, memberId);
  if (found) return getThread(found)!;
  const room = createRoom(`${botName} · for ${memberName}`, [botId], ownerId);
  ensureDatabase().query("UPDATE gond_threads SET errand_bot = ?, errand_for = ? WHERE id = ?").run(botId, memberId, room.id);
  return getThread(room.id)!;
}

type ErrandRaw = {
  id: string;
  bot_id: string;
  member_id: string;
  from_bot_id: string;
  from_thread_id: string;
  errand_thread_id: string;
  request: string;
  level: string;
  status: ErrandStatus;
  prompt_id: string | null;
  answer: string | null;
  created_at: string;
};

function toErrand(row: ErrandRaw): ErrandRow {
  return {
    id: row.id,
    botId: row.bot_id,
    memberId: row.member_id,
    fromBotId: row.from_bot_id,
    fromThreadId: row.from_thread_id,
    errandThreadId: row.errand_thread_id,
    request: row.request,
    level: isSpaceLevel(row.level) ? row.level : "talk",
    status: row.status,
    promptId: row.prompt_id,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

export function createErrand(input: Omit<ErrandRow, "id" | "status" | "promptId" | "answer" | "createdAt">): ErrandRow {
  const id = newId("errand");
  ensureDatabase()
    .query("INSERT INTO gond_household_errands (id, bot_id, member_id, from_bot_id, from_thread_id, errand_thread_id, request, level, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .run(id, input.botId, input.memberId, input.fromBotId, input.fromThreadId, input.errandThreadId, input.request, input.level, now());
  return getErrand(id)!;
}

export function getErrand(id: string): ErrandRow | null {
  const row = ensureDatabase().query("SELECT * FROM gond_household_errands WHERE id = ?").get(id) as ErrandRaw | null;
  return row ? toErrand(row) : null;
}

export function errandOfPrompt(promptId: string): ErrandRow | null {
  const row = ensureDatabase().query("SELECT * FROM gond_household_errands WHERE prompt_id = ?").get(promptId) as ErrandRaw | null;
  return row ? toErrand(row) : null;
}

export function setErrandPrompt(id: string, promptId: string): void {
  ensureDatabase().query("UPDATE gond_household_errands SET prompt_id = ? WHERE id = ?").run(promptId, id);
}

/** Closes an open errand; false when it was already closed, so only one ending tells the asker. */
export function finishErrand(id: string, status: Exclude<ErrandStatus, "open">, answer: string | null): boolean {
  return ensureDatabase().query("UPDATE gond_household_errands SET status = ?, answer = ?, finished_at = ? WHERE id = ? AND status = 'open'").run(status, answer, now(), id).changes > 0;
}

export function openErrandsIn(errandThreadId: string): ErrandRow[] {
  return (ensureDatabase().query("SELECT * FROM gond_household_errands WHERE errand_thread_id = ? AND status = 'open'").all(errandThreadId) as ErrandRaw[]).map(toErrand);
}
