import { ALL_NOTICES, type DeviceNotices } from "@gond/shared";
import { randomBytes } from "node:crypto";
import { ensureDatabase } from "../db/init.ts";
import { newId, now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

export type PushPlatform = "android" | "ios";

/**
 * A phone that gets the person's notices as push (through the relay and Firebase). Each has
 * two keys of its own, made here and handed to the phone once: one seals the notices so only that
 * phone reads them, the other signs its answers to cards from the lock screen.
 */
export type PushDevice = { id: string; userId: string; platform: PushPlatform; token: string; sealKey: string; answerKey: string; notices: DeviceNotices };

type Row = { id: string; user_id: string; platform: string; token: string; seal_key: string; answer_key: string; muted_bots: string; other: number };

function readMuted(json: string): string[] {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toDevice(row: Row): PushDevice {
  return { id: row.id, userId: row.user_id, platform: row.platform === "ios" ? "ios" : "android", token: row.token, sealKey: decryptSecret(row.seal_key), answerKey: decryptSecret(row.answer_key), notices: { mutedBots: readMuted(row.muted_bots), other: row.other !== 0 } };
}

export function listPushDevices(userId: string): PushDevice[] {
  return (ensureDatabase().query("SELECT * FROM gond_push_devices WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toDevice);
}

export function getPushDevice(id: string): PushDevice | null {
  const row = ensureDatabase().query("SELECT * FROM gond_push_devices WHERE id = ?").get(id) as Row | null;
  return row ? toDevice(row) : null;
}

/**
 * A phone signing up, or checking in again. The same phone with the same token keeps its keys; a
 * new token, or a phone this server doesn't know, gets new ones, and the token leaves any phone
 * that had it before.
 */
export function registerPushDevice(userId: string, input: { platform: PushPlatform; token: string; id?: string | null; notices?: DeviceNotices | null }): { id: string; keys: { seal: string; answer: string } | null } {
  const db = ensureDatabase();
  const at = now();
  const known = input.id ? (db.query("SELECT * FROM gond_push_devices WHERE id = ? AND user_id = ? AND token = ?").get(input.id, userId, input.token) as Row | null) : null;
  if (known) {
    if (input.notices) setPushDeviceNotices(known.id, userId, input.notices);
    return { id: known.id, keys: null };
  }
  const id = newId("dev");
  const seal = randomBytes(32).toString("base64url");
  const answer = randomBytes(32).toString("base64url");
  const notices = input.notices ?? ALL_NOTICES;
  db.transaction(() => {
    db.query("DELETE FROM gond_push_devices WHERE token = ?").run(input.token);
    if (input.id) db.query("DELETE FROM gond_push_devices WHERE id = ? AND user_id = ?").run(input.id, userId);
    db.query("INSERT INTO gond_push_devices (id, user_id, platform, token, seal_key, answer_key, muted_bots, other, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      userId,
      input.platform,
      input.token,
      encryptSecret(seal),
      encryptSecret(answer),
      JSON.stringify(notices.mutedBots),
      notices.other ? 1 : 0,
      at,
      at,
    );
  })();
  return { id, keys: { seal, answer } };
}

export function setPushDeviceNotices(id: string, userId: string, notices: DeviceNotices): boolean {
  return ensureDatabase().query("UPDATE gond_push_devices SET muted_bots = ?, other = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(notices.mutedBots), notices.other ? 1 : 0, now(), id, userId).changes > 0;
}

export function removePushDevice(id: string, userId?: string): boolean {
  const db = ensureDatabase();
  return (userId ? db.query("DELETE FROM gond_push_devices WHERE id = ? AND user_id = ?").run(id, userId) : db.query("DELETE FROM gond_push_devices WHERE id = ?").run(id)).changes > 0;
}
