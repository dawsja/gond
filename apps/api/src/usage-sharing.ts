import { type UsageSharing } from "@gond/shared";
import { setUsageSharing, usageSharing } from "./data/settings.ts";
import { serverTokens } from "./data/usage.ts";
import { signUsage } from "./federation.ts";
import { PUSH_RELAY_URL } from "./phone-push.ts";

// The relay takes one report a key every ten minutes; an hour keeps well clear of it.
const EVERY_MS = 60 * 60 * 1000;
const FIRST_MS = 60 * 1000;

export function sharingState(): UsageSharing {
  const state = usageSharing();
  return { on: state !== null, since: state?.since ?? null, tokens: state ? serverTokens(state.since) : 0 };
}

/**
 * Sends this server's running total to api.gond.io, signed with its key: only the number, while the
 * admin has sharing on. A report that fails waits for the next one, which carries the same total and more.
 */
export async function reportUsage(relayUrl = PUSH_RELAY_URL): Promise<boolean> {
  const state = usageSharing();
  if (!state) return false;
  const report = await signUsage({ epoch: state.epoch, tokens: serverTokens(state.since) });
  const res = await fetch(`${relayUrl}/v1/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  await res?.body?.cancel().catch(() => undefined);
  return Boolean(res?.ok);
}

let soon: ReturnType<typeof setTimeout> | null = null;

function reportSoon(ms: number) {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => {
    soon = null;
    void reportUsage().catch((error: unknown) => console.warn("[gond] couldn't share the usage count:", error));
  }, ms);
  soon.unref?.();
}

/** Turned on, the first report goes a minute later; turned off, nothing more goes. */
export function changeSharing(on: boolean): UsageSharing {
  setUsageSharing(on);
  if (on) reportSoon(FIRST_MS);
  else if (soon) clearTimeout(soon);
  return sharingState();
}

export function startUsageSharing() {
  if (usageSharing()) reportSoon(FIRST_MS);
  const timer = setInterval(() => {
    if (usageSharing()) reportSoon(0);
  }, EVERY_MS);
  timer.unref?.();
}
