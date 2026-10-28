import { LIMITS, fromB64, parsePush, signedPush, toB64, utf8, verifySignature, type PushResult } from "./protocol.ts";

/**
 * Pushes to Android phones through Firebase Cloud Messaging's v1 API, as the service account
 * the relay holds (FCM_SERVICE_ACCOUNT on Cloudflare). Gond servers never hold it: each signs a
 * push with its own key and the relay sends it on, so a self-hosted Gond reaches its phones with
 * nothing of Google's to set up.
 */

export type Fcm = { send(token: string, data: Record<string, string>, collapse: string | null): Promise<PushResult> };

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

export function createFcm(serviceAccount: string, options: { fetch?: typeof fetch; now?: () => number; endpoint?: string } = {}): Fcm {
  const account = JSON.parse(serviceAccount) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key) throw new Error("FCM_SERVICE_ACCOUNT isn't a Firebase service account key");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokenUri = account.token_uri ?? TOKEN_URI;
  const endpoint = options.endpoint ?? "https://fcm.googleapis.com";
  let cached: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.until > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const assertion = await signJwt(account, { iss: account.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 });
    const res = await fetcher(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !body?.access_token) throw new Error(`Google didn't give an access token (${res.status})`);
    cached = { token: body.access_token, until: now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000 };
    return cached.token;
  }

  return {
    async send(token, data, collapse) {
      let auth: string;
      try {
        auth = await accessToken();
      } catch {
        return "failed";
      }
      const message = { token, data, android: { priority: "HIGH", ttl: "3600s", ...(collapse ? { collapse_key: collapse } : {}) } };
      const res = await fetcher(`${endpoint}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ message }),
      }).catch(() => null);
      if (!res) return "failed";
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return "sent";
      if (res.status === 401) cached = null;
      // NOT_FOUND is a token the phone gave up: the app was removed or its data cleared.
      return res.status === 404 ? "gone" : "failed";
    },
  };
}

async function signJwt(account: ServiceAccount, claims: Record<string, unknown>): Promise<string> {
  const part = (value: unknown) => toB64(utf8(JSON.stringify(value)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}`;
  const der = fromB64(account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return `${unsigned}.${toB64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(unsigned)))}`;
}

export type PushAnswer = { status: number; body: { result: PushResult } | { error: string } };

/** One `/v1/push` request: checked, signed by a Gond's key, counted against that key, then sent. */
export async function handlePush(raw: unknown, deps: { fcm: Fcm | null; spend: (key: string, limit: number) => boolean; now: () => number }): Promise<PushAnswer> {
  const push = parsePush(raw);
  if (!push) return { status: 400, body: { error: "That isn't a version 1 push." } };
  if (!deps.fcm) return { status: 503, body: { error: "This relay doesn't send push notifications." } };
  if (Math.abs(deps.now() - push.at) > LIMITS.pushSkewMs) return { status: 400, body: { error: "The push's time is too far from the relay's." } };
  const { sig, ...signed } = push;
  if (!(await verifySignature(push.from, sig, signedPush(signed)))) return { status: 401, body: { error: "The push's signature doesn't match its sender." } };
  if (!deps.spend(`push:${push.from}`, LIMITS.pushesPerMinute)) return { status: 429, body: { error: `At most ${LIMITS.pushesPerMinute} pushes a minute.` } };
  const result = await deps.fcm.send(push.token, { d: push.data }, push.collapse);
  return { status: result === "sent" ? 200 : result === "gone" ? 410 : 502, body: { result } };
}
