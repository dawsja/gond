import type { SignIns } from "@gond/shared";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cookiesOf, jar, startGond } from "./oidc-gond.ts";

/*
 * The other way round: someone signed in with the provider before linking, so it made an account of
 * its own. That account moves its sign-in to the local one, proven by the local password, and goes.
 */

let gond: Awaited<ReturnType<typeof startGond>>;

beforeAll(async () => {
  gond = await startGond();
});

afterAll(async () => {
  await gond?.stop();
});

test("an account the provider made moves its sign-in to the local account, which then opens with it", async () => {
  const { url, me, post, signInWithProvider } = gond;
  const signIns = async (cookie: string) => (await (await fetch(`${url}/api/me/sign-ins`, { headers: { Cookie: cookie } })).json()) as SignIns;
  const local = await gond.setUp();
  const localId = await me(local);

  const made = jar((await signInWithProvider("dawson")).cookies);
  const madeId = await me(made);
  expect(madeId).not.toBe(localId);
  expect(await signIns(made)).toEqual({ password: false, oidc: { name: "Acme", linked: true }, move: { bots: 0, chats: 0 } });
  expect((await signIns(local)).move).toBeNull();

  // The local account's password proves it; a wrong one moves nothing, and the local account can't move.
  expect((await post("/api/me/sign-ins/move", { username: "dawson", password: "not-the-password" }, made)).status).toBe(401);
  expect((await post("/api/me/sign-ins/move", { username: "dawson", password: "a-long-test-password" }, local)).status).toBe(400);

  // An account with something in it says what goes and needs a yes.
  const bot = await fetch(`${url}/api/bots`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: made }, body: JSON.stringify({ name: "Scout", title: "", description: "", color: "#2c62ba", expression: "happy", shape: "cog", approval: "auto", notify: true }) });
  expect(bot.ok).toBe(true);
  expect((await signIns(made)).move).toEqual({ bots: 1, chats: 0 });
  expect((await post("/api/me/sign-ins/move", { username: "dawson", password: "a-long-test-password" }, made)).status).toBe(409);

  const moved = await post("/api/me/sign-ins/move", { username: "dawson", password: "a-long-test-password", confirm: true }, made);
  expect(moved.ok).toBe(true);
  expect(await me(jar(cookiesOf(moved)))).toBe(localId);
  expect(await signIns(local)).toEqual({ password: true, oidc: { name: "Acme", linked: true }, move: null });

  // The account the provider made is gone, its session with it, and the provider now opens the local account.
  expect((await fetch(`${url}/api/me`, { headers: { Cookie: made } })).status).toBe(401);
  expect(await me(jar((await signInWithProvider("dawson")).cookies))).toBe(localId);
  const users = (await (await fetch(`${url}/api/users`, { headers: { Cookie: local } })).json()) as { users: { id: string }[] };
  expect(users.users.map((u) => u.id)).toEqual([localId]);

  // Another provider account can't take a local account that already signs in with the provider.
  const other = jar((await signInWithProvider("cy")).cookies);
  expect((await signIns(other)).move).toBeNull();
  expect((await post("/api/me/sign-ins/move", { username: "dawson", password: "a-long-test-password" }, other)).status).toBe(409);
}, 60_000);
