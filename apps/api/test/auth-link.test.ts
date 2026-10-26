import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * Moving from the local account to the organisation's provider: a real API and a stand-in OIDC
 * provider. The local account links the provider's sign-in, and signing in with it afterwards
 * lands in that same account; a sign-in that already made an account of its own isn't linked.
 */

const people: Record<string, { sub: string; email: string; name: string }> = {
  dawson: { sub: "dawson-1", email: "dawson@example.com", name: "Dawson" },
  cy: { sub: "cy-2", email: "cy@example.com", name: "Cy" },
};

let provider: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.spawn>;
let url = "";
let dir = "";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
const jar = (...lists: string[][]) => [...new Map(lists.flat().map((c) => [c.split("=")[0], c])).values()].join("; ");

async function post(route: string, body: unknown, cookie = "") {
  return fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: cookie }, body: JSON.stringify(body) });
}

/** Starts a sign-in or a link at the provider and comes back as `who`, as a browser would: the address it lands on, and its cookies. */
async function viaProvider(start: string, body: unknown, who: string, cookie = ""): Promise<{ location: string; cookies: string[] }> {
  const begun = await post(start, { ...(body as object), disableRedirect: true }, cookie);
  expect(begun.ok).toBe(true);
  const { url: authorize } = (await begun.json()) as { url: string };
  const state = new URL(authorize).searchParams.get("state")!;
  const back = await fetch(`${url}/api/auth/callback/oidc?code=${who}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: jar(cookie ? cookie.split("; ").map((c) => [c]).flat() : [], cookiesOf(begun)) } });
  return { location: back.headers.get("location") ?? "", cookies: cookiesOf(back) };
}

beforeAll(async () => {
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const base = `http://127.0.0.1:${provider.port}`;
      const at = new URL(request.url);
      if (at.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo`, jwks_uri: `${base}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
      if (at.pathname === "/token") {
        const code = new URLSearchParams(await request.text()).get("code") ?? "";
        return Response.json({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 3600 });
      }
      if (at.pathname === "/userinfo") {
        const who = people[(request.headers.get("authorization") ?? "").replace("Bearer token-", "")];
        return who ? Response.json({ sub: who.sub, email: who.email, email_verified: true, name: who.name }) : new Response("no", { status: 401 });
      }
      if (at.pathname === "/jwks") return Response.json({ keys: [] });
      return new Response("not here", { status: 404 });
    },
  });
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(path.join(tmpdir(), "gond-auth-link-"));
  api = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(port), APP_URL: url, GOND_DATA_DIR: dir, GOND_SETUP_TOKEN: "link-test-token", GOND_SECRET_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), GOND_BOX_URL: "", NODE_ENV: "test" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("The API didn't start");
});

afterAll(async () => {
  api?.kill();
  await api?.exited;
  provider?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("the local account links the provider's sign-in, and signing in with it lands in the same account", async () => {
  const registered = await post("/api/register", { token: "link-test-token", username: "dawson", password: "a-long-test-password", confirm: "a-long-test-password" });
  expect(registered.ok).toBe(true);
  const local = jar(cookiesOf(registered));
  const me = async (cookie: string) => ((await (await fetch(`${url}/api/me`, { headers: { Cookie: cookie } })).json()) as { user: { id: string } }).user.id;
  const localId = await me(local);

  const configured = await fetch(`${url}/api/oidc`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: url, Cookie: local }, body: JSON.stringify({ enabled: true, name: "Acme", issuer: `http://127.0.0.1:${provider.port}`, clientId: "gond", clientSecret: "a-client-secret", scopes: "openid profile email" }) });
  expect(configured.ok).toBe(true);
  const signIns = async (cookie: string) => (await (await fetch(`${url}/api/me/sign-ins`, { headers: { Cookie: cookie } })).json()) as { password: boolean; oidc: { name: string; linked: boolean } | null };
  expect(await signIns(local)).toEqual({ password: true, oidc: { name: "Acme", linked: false } });

  // Linked from Settings → Account while signed in: back on the account page, and the provider's sign-in is this account's.
  const linked = await viaProvider("/api/auth/link-social", { provider: "oidc", callbackURL: "/app/settings/account?linked=1", errorCallbackURL: "/app/settings/account" }, "dawson", local);
  expect(linked.location).toContain("/app/settings/account?linked=1");
  expect(await signIns(local)).toEqual({ password: true, oidc: { name: "Acme", linked: true } });

  // Signing in with the provider afterwards opens the same account, not a new one.
  const signedIn = await viaProvider("/api/auth/sign-in/social", { provider: "oidc", callbackURL: "/app", errorCallbackURL: "/login?error=oidc" }, "dawson");
  expect(signedIn.location).toContain("/app");
  expect(await me(jar(signedIn.cookies))).toBe(localId);

  // A provider sign-in that already made its own account is never linked over it.
  const other = await viaProvider("/api/auth/sign-in/social", { provider: "oidc", callbackURL: "/app", errorCallbackURL: "/login?error=oidc" }, "cy");
  expect(await me(jar(other.cookies))).not.toBe(localId);
  const refused = await viaProvider("/api/auth/link-social", { provider: "oidc", callbackURL: "/app/settings/account?linked=1", errorCallbackURL: "/app/settings/account" }, "cy", local);
  expect(refused.location).toContain("error=account_already_linked_to_different_user");
}, 60_000);

test("another site can't sign the browser in: not through Better Auth, nor through the apps' redeem link", async () => {
  const signIn = (origin: string) => fetch(`${url}/api/auth/sign-in/username`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: "dawson", password: "a-long-test-password" }) });
  const foreign = await signIn("https://evil.example");
  expect(foreign.status).toBe(403);
  expect(foreign.headers.getSetCookie()).toHaveLength(0);
  expect((await signIn(url)).ok).toBe(true);

  // A link or image elsewhere gets the sign-in page and no session; the apps' own load still reaches the code check.
  const redeem = (headers: Record<string, string>) => fetch(`${url}/api/mobile-sign-in/redeem?code=x&verifier=y`, { redirect: "manual", headers });
  for (const headers of [{ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" }, { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "document" }, { "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "image" }]) {
    const res = await redeem(headers);
    expect(res.headers.get("location")).toBe("/login?error=oidc");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  }
});
