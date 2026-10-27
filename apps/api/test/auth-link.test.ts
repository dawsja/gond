import type { SignIns } from "@gond/shared";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { jar, startGond } from "./oidc-gond.ts";

/*
 * Moving from the local account to the organisation's provider: a real API and a stand-in OIDC
 * provider. The local account links the provider's sign-in, and signing in with it afterwards
 * lands in that same account; a sign-in that already made an account of its own isn't linked.
 */

let gond: Awaited<ReturnType<typeof startGond>>;
let url = "";

beforeAll(async () => {
  gond = await startGond();
  url = gond.url;
});

afterAll(async () => {
  await gond?.stop();
});

test("the local account links the provider's sign-in, and signing in with it lands in the same account", async () => {
  const { me, viaProvider, signInWithProvider } = gond;
  const local = await gond.setUp();
  const localId = await me(local);
  const signIns = async (cookie: string) => (await (await fetch(`${url}/api/me/sign-ins`, { headers: { Cookie: cookie } })).json()) as SignIns;
  expect(await signIns(local)).toEqual({ password: true, oidc: { name: "Acme", linked: false }, move: null });

  // Linked from Settings → Account while signed in: back on the account page, and the provider's sign-in is this account's.
  const linked = await viaProvider("/api/auth/link-social", { provider: "oidc", callbackURL: "/app/settings/account?linked=1", errorCallbackURL: "/app/settings/account" }, "dawson", local);
  expect(linked.location).toContain("/app/settings/account?linked=1");
  expect(await signIns(local)).toEqual({ password: true, oidc: { name: "Acme", linked: true }, move: null });

  // Signing in with the provider afterwards opens the same account, not a new one.
  const signedIn = await signInWithProvider("dawson");
  expect(signedIn.location).toContain("/app");
  expect(await me(jar(signedIn.cookies))).toBe(localId);

  // A provider sign-in that already made its own account is never linked over it.
  const other = await signInWithProvider("cy");
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
