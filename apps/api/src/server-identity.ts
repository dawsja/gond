import { createIdentity, pushRequest, usageReport, type Identity } from "@gond/relay/client";
import type { PushRequest, UsageReport } from "@gond/relay/protocol";
import { ensureDatabase } from "./db/init.ts";
import { dbPath } from "./db/sqlite.ts";
import { now } from "./ids.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const holder = globalThis as typeof globalThis & { __gondServerIdentity?: { path: string; identity: Identity } };

async function serverIdentity(): Promise<Identity> {
  const path = dbPath();
  if (holder.__gondServerIdentity?.path === path) return holder.__gondServerIdentity.identity;
  const db = ensureDatabase();
  const row = db.query("SELECT identity FROM gond_server_identity WHERE id = 1").get() as { identity: string } | null;
  if (row?.identity) {
    const { key, secret } = JSON.parse(decryptSecret(row.identity)) as Identity;
    const loaded: Identity = { key, secret };
    holder.__gondServerIdentity = { path, identity: loaded };
    return loaded;
  }
  const made = await createIdentity();
  db.query("INSERT OR REPLACE INTO gond_server_identity (id, key, identity, updated_at) VALUES (1, ?, ?, ?)").run(
    made.key,
    encryptSecret(JSON.stringify(made)),
    now(),
  );
  holder.__gondServerIdentity = { path, identity: made };
  return made;
}

export async function signPush(input: { token: string; data: string; collapse: string | null; platform: PushRequest["platform"]; quiet?: boolean }): Promise<PushRequest> {
  return pushRequest(await serverIdentity(), input);
}

export async function signUsage(input: { epoch: string; tokens: number }): Promise<UsageReport> {
  return usageReport(await serverIdentity(), input);
}
