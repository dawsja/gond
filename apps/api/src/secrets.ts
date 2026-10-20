import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDataDir, env } from "./config.ts";

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

type KeyCache = { source: string; key: Buffer };
const holder = globalThis as typeof globalThis & { __gondSecretKey?: KeyCache };

function parseKey(raw: string, source: string) {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new SecretKeyError(`${source} must be 32 random bytes, base64 encoded. Generate one with: openssl rand -base64 32`);
  }
  return key;
}

/**
 * The master key: `GOND_SECRET_KEY` when set, otherwise `secret.key` in the
 * data directory, created on first use with 0600 permissions.
 */
export function masterKey(): Buffer {
  const envKey = env("SECRET_KEY");
  const file = path.join(ensureDataDir(), "secret.key");
  const source = envKey ? "env" : file;
  const cached = holder.__gondSecretKey;
  if (cached?.source === source) return cached.key;

  let key: Buffer;
  if (envKey) {
    key = parseKey(envKey, "GOND_SECRET_KEY");
  } else {
    if (!existsSync(file)) {
      try {
        writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    }
    key = parseKey(readFileSync(file, "utf8"), file);
  }
  holder.__gondSecretKey = { source, key };
  return key;
}

export function resetSecretKeyCache() {
  holder.__gondSecretKey = undefined;
}

function derive(info: string) {
  return Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), info, 32));
}

function subkey(purpose: string) {
  return derive(`gond:${purpose}`);
}

/** The key a `v1.` value was written with, from before the rename. */
function legacySubkey(purpose: string) {
  return derive(`kru:${purpose}`);
}

const FORMAT = "v2";
const LEGACY_FORMAT = "v1";

export function isLegacySecret(value: string): boolean {
  return value.startsWith(`${LEGACY_FORMAT}.`);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey("secrets"), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [format, iv, tag, ciphertext] = value.split(".");
  if ((format !== FORMAT && format !== LEGACY_FORMAT) || !iv || !tag || ciphertext === undefined) {
    throw new SecretKeyError("A stored secret has an unknown format");
  }
  const key = format === LEGACY_FORMAT ? legacySubkey("secrets") : subkey("secrets");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError("Stored secrets can't be decrypted: data/secret.key or GOND_SECRET_KEY does not match this database");
  }
}

export function derivedAuthSecret() {
  return subkey("better-auth").toString("base64url");
}
