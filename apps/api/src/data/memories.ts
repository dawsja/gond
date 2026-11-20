import { createHash } from "node:crypto";
import { ensureDatabase, transaction } from "../db/init.ts";
import { now } from "../ids.ts";
import { mergeMemory } from "../memory.ts";

/** Whose memory: a bot's own, or a profile's team memory, which every one of its bots carries. */
export type MemoryOwner = { bot: string } | { team: string };

/** The main memory, MEMORY.md, that loads into every turn; every other topic is read when its subject comes up. */
export const MAIN_TOPIC = "";

function table(owner: MemoryOwner): { name: string; key: string; id: string } {
  return "bot" in owner ? { name: "gond_bot_memory", key: "bot_id", id: owner.bot } : { name: "gond_team_memory", key: "user_id", id: owner.team };
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readMemory(owner: MemoryOwner, topic = MAIN_TOPIC): string | null {
  const { name, key, id } = table(owner);
  const row = ensureDatabase().query(`SELECT content FROM ${name} WHERE ${key} = ? AND topic = ?`).get(id, topic) as { content: string } | null;
  return row?.content ?? null;
}

/** Replaces a topic; text that is only space removes it. */
export function writeMemory(owner: MemoryOwner, topic: string, content: string): void {
  const { name, key, id } = table(owner);
  const db = ensureDatabase();
  if (!content.trim()) {
    db.query(`DELETE FROM ${name} WHERE ${key} = ? AND topic = ?`).run(id, topic);
    return;
  }
  db.query(`INSERT INTO ${name} (${key}, topic, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (${key}, topic) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`).run(id, topic, content, now());
}

export type MemoryTopic = { topic: string; bytes: number; updatedAt: string };

/** Every topic but the main memory, by name. */
export function memoryTopics(owner: MemoryOwner): MemoryTopic[] {
  const { name, key, id } = table(owner);
  const rows = ensureDatabase().query(`SELECT topic, LENGTH(CAST(content AS BLOB)) AS bytes, updated_at FROM ${name} WHERE ${key} = ? AND topic != '' ORDER BY topic`).all(id) as { topic: string; bytes: number; updated_at: string }[];
  return rows.map((row) => ({ topic: row.topic, bytes: row.bytes, updatedAt: row.updated_at }));
}

/** Whether this memory is still on the computer, from before memory moved here, waiting to be moved in. */
export function memoryOnComputer(owner: MemoryOwner): boolean {
  const row = "bot" in owner ? ensureDatabase().query("SELECT 1 FROM gond_memory_moves WHERE bot_id = ?").get(owner.bot) : ensureDatabase().query("SELECT 1 FROM gond_memory_moves WHERE user_id = ?").get(owner.team);
  return row !== null;
}

/** Every bot and profile whose memory still waits on the computer. */
export function memoriesOnComputer(): MemoryOwner[] {
  const rows = ensureDatabase().query("SELECT bot_id, user_id FROM gond_memory_moves").all() as { bot_id: string | null; user_id: string | null }[];
  return rows.map((row) => (row.bot_id ? { bot: row.bot_id } : { team: row.user_id! }));
}

export type MovedFile = { topic: string; content: string };

/**
 * Brings what was found on the computer into the memory, all of it in one transaction, and with
 * `last` marks the memory moved. Text already here, or already moved in from the same file once, is
 * left as it is; anything else is merged so that nothing either side holds is lost (`mergeMemory`).
 */
export function moveMemoryFiles(owner: MemoryOwner, files: MovedFile[], last: boolean): void {
  const { name, key, id } = table(owner);
  transaction((db) => {
    for (const file of files) {
      const hash = hashOf(file.content);
      const row = db.query(`SELECT content, moved_hash FROM ${name} WHERE ${key} = ? AND topic = ?`).get(id, file.topic) as { content: string; moved_hash: string | null } | null;
      if (row?.moved_hash === hash) continue;
      const content = mergeMemory(row?.content ?? null, file.content);
      db.query(`INSERT INTO ${name} (${key}, topic, content, moved_hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (${key}, topic) DO UPDATE SET content = excluded.content, moved_hash = excluded.moved_hash, updated_at = excluded.updated_at`).run(id, file.topic, content, hash, now());
    }
    if (last) {
      if ("bot" in owner) db.query("DELETE FROM gond_memory_moves WHERE bot_id = ?").run(owner.bot);
      else db.query("DELETE FROM gond_memory_moves WHERE user_id = ?").run(owner.team);
    }
  });
}
