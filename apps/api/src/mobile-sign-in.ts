import { DESKTOP_SIGN_IN_CALLBACK, MOBILE_SIGN_IN_CALLBACK, type SignInApp } from "@gond/shared";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CODE_TTL_MS = 2 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Pending = { session: string; challenge: string; expires: number };
const holder = globalThis as typeof globalThis & { __gondMobileCodes?: Map<string, Pending> };
const codes = (holder.__gondMobileCodes ??= new Map());

const CALLBACKS: Record<SignInApp, string> = { android: MOBILE_SIGN_IN_CALLBACK, ios: MOBILE_SIGN_IN_CALLBACK, desktop: DESKTOP_SIGN_IN_CALLBACK };
export type { SignInApp };

export function signInApp(value: unknown): SignInApp {
  return value === "desktop" || value === "ios" ? value : "android";
}

export function signInCallback(app: SignInApp): string {
  return CALLBACKS[app];
}

export function isChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function issueCode(session: string, challenge: string, now = Date.now()): string {
  for (const [code, pending] of codes) if (pending.expires <= now) codes.delete(code);
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { session, challenge, expires: now + CODE_TTL_MS });
  return code;
}

export function redeemCode(code: string, verifier: string, now = Date.now()): string | null {
  const pending = codes.get(code);
  if (!pending) return null;
  codes.delete(code);
  if (pending.expires <= now) return null;
  const given = Buffer.from(challengeFor(verifier));
  const expected = Buffer.from(pending.challenge);
  return given.length === expected.length && timingSafeEqual(given, expected) ? pending.session : null;
}

export function safePath(value: unknown, fallback = "/app"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
