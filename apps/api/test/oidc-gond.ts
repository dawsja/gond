import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A real API on a fresh data directory, beside a stand-in OIDC provider that signs in whoever a code names. */

export const SETUP_TOKEN = "link-test-token";

const people: Record<string, { sub: string; email: string; name: string }> = {
  dawson: { sub: "dawson-1", email: "dawson@example.com", name: "Dawson" },
  cy: { sub: "cy-2", email: "cy@example.com", name: "Cy" },
};

export const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
export const jar = (...lists: string[][]) => [...new Map(lists.flat().map((c) => [c.split("=")[0], c])).values()].join("; ");

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

export async function startGond() {
  const provider: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
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
  const url = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "gond-auth-link-"));
  const api = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(port), APP_URL: url, GOND_DATA_DIR: dir, GOND_SETUP_TOKEN: SETUP_TOKEN, GOND_SECRET_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), GOND_BOX_URL: "", NODE_ENV: "test" },
    stdout: "ignore",
    stderr: "ignore",
  });

  const post = (route: string, body: unknown, cookie = "") =>
    fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: cookie }, body: JSON.stringify(body) });

  /** Starts a sign-in or a link at the provider and comes back as `who`, as a browser would: the address it lands on, and its cookies. */
  async function viaProvider(start: string, body: unknown, who: string, cookie = ""): Promise<{ location: string; cookies: string[] }> {
    const begun = await post(start, { ...(body as object), disableRedirect: true }, cookie);
    expect(begun.ok).toBe(true);
    const { url: authorize } = (await begun.json()) as { url: string };
    const state = new URL(authorize).searchParams.get("state")!;
    const back = await fetch(`${url}/api/auth/callback/oidc?code=${who}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: jar(cookie ? cookie.split("; ") : [], cookiesOf(begun)) } });
    return { location: back.headers.get("location") ?? "", cookies: cookiesOf(back) };
  }

  const signInWithProvider = (who: string) => viaProvider("/api/auth/sign-in/social", { provider: "oidc", callbackURL: "/app", errorCallbackURL: "/login?error=oidc" }, who);

  const me = async (cookie: string) => ((await (await fetch(`${url}/api/me`, { headers: { Cookie: cookie } })).json()) as { user: { id: string } }).user.id;

  /** Registers the local account and points Gond at the provider, signed in as that account. */
  async function setUp(): Promise<string> {
    const registered = await post("/api/register", { token: SETUP_TOKEN, username: "dawson", password: "a-long-test-password", confirm: "a-long-test-password" });
    expect(registered.ok).toBe(true);
    const local = jar(cookiesOf(registered));
    const configured = await fetch(`${url}/api/oidc`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: url, Cookie: local }, body: JSON.stringify({ enabled: true, name: "Acme", issuer: `http://127.0.0.1:${provider.port}`, clientId: "gond", clientSecret: "a-client-secret", scopes: "openid profile email" }) });
    expect(configured.ok).toBe(true);
    return local;
  }

  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false)) break;
    if (i === 99) throw new Error("The API didn't start");
    await Bun.sleep(100);
  }

  async function stop() {
    api.kill();
    await api.exited;
    provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }

  return { url, post, viaProvider, signInWithProvider, me, setUp, stop };
}
