import type { SignIns } from "@gond/shared";
import { verifyPassword } from "better-auth/crypto";
import { Hono } from "hono";
import { personId } from "../access.ts";
import type { Env } from "../app.ts";
import { getAuth } from "../auth.ts";
import { getOidcSettings, oidcReady } from "../data/oidc.ts";
import { contentsOf, forgetAccount, moveProviderSignIn, passwordAccount, signInsOf, unlinkedPasswordAccount } from "../data/users.ts";
import { removePerson } from "../profiles.ts";

const TRIES_PER_MINUTE = 5;
const tries = new Map<string, number[]>();

/** Password guesses through the move are held to the sign-in page's own limit. */
function tooManyTries(person: string): boolean {
  const since = Date.now() - 60_000;
  const recent = (tries.get(person) ?? []).filter((at) => at > since);
  recent.push(Date.now());
  tries.set(person, recent);
  return recent.length > TRIES_PER_MINUTE;
}

/** Only an account the provider made, with no password of its own, can move to one that has a password. */
function canMove(person: string): boolean {
  const has = signInsOf(person);
  return oidcReady() && has.oidc && !has.password;
}

export function signInsRoutes() {
  const app = new Hono<Env>();

  app.get("/me/sign-ins", (c) => {
    const person = personId(c);
    const has = signInsOf(person);
    const oidc = oidcReady() ? { name: getOidcSettings().name, linked: has.oidc } : null;
    const move = canMove(person) && unlinkedPasswordAccount() ? contentsOf(person) : null;
    return c.json({ password: has.password, oidc, move } satisfies SignIns);
  });

  /**
   * Moves the provider's sign-in from the account it made to one with a password, proven by that
   * password, then removes the account it made and everything in it. The person is signed in to the
   * other account in the same answer.
   */
  app.post("/me/sign-ins/move", async (c) => {
    const person = personId(c);
    if (!canMove(person)) return c.json({ error: "This account already signs in with a password" }, 400);
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown; confirm?: unknown } | null;
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) return c.json({ error: "Type the username and password of your other account" }, 400);
    if (tooManyTries(person)) return c.json({ error: "Too many tries. Wait a minute, then try again." }, 429);

    const target = passwordAccount(username);
    if (!target || !(await verifyPassword({ hash: target.hash, password }))) return c.json({ error: "That username and password don't match" }, 401);
    const name = getOidcSettings().name;
    if (signInsOf(target.userId).oidc) return c.json({ error: `That account already signs in with ${name}` }, 409);
    const contents = contentsOf(person);
    if ((contents.bots > 0 || contents.chats > 0) && body?.confirm !== true) return c.json({ error: "This account has bots or chats of its own. Confirm that they can be deleted." }, 409);

    const auth = await getAuth();
    const signedIn = await auth.api.signInUsername({ body: { username, password }, headers: c.req.raw.headers, asResponse: true });
    if (!signedIn.ok) return c.json({ error: "Couldn't sign in to that account. Try again." }, 502);
    moveProviderSignIn(person, target.userId);
    await removePerson(person);
    forgetAccount(person);

    const headers = new Headers({ "Content-Type": "application/json" });
    for (const cookie of signedIn.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify({ ok: true }), { headers });
  });

  return app;
}
