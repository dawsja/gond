import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

const warned = new Set<string>();

export function env(name: string): string | undefined {
  const value = process.env[`GOND_${name}`];
  if (value !== undefined) return value;
  const legacy = process.env[`KRU_${name}`];
  if (legacy !== undefined && !warned.has(name)) {
    warned.add(name);
    console.warn(`[gond] KRU_${name} is now GOND_${name}; the old name stops working in the next release.`);
  }
  return legacy;
}

export function dataDir() {
  return path.resolve(env("DATA_DIR") ?? path.join(process.cwd(), "data"));
}

export function ensureDataDir() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function apiPort() {
  return Number(process.env.PORT || 8790);
}

export const TURNS_PER_PERSON = 3;

export function turnTiming() {
  return ["1", "true", "yes", "on"].includes((env("TURN_TIMING") ?? "").trim().toLowerCase());
}

export function approvalTimeoutMs() {
  return Math.max(1, Number(env("APPROVAL_TIMEOUT_MINUTES") ?? 30) || 30) * 60_000;
}
