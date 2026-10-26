import { isAccent, isEmojiLevel, isReplyStyle, type SignIns } from "@gond/shared";
import { Hono } from "hono";
import type { Session } from "./auth.ts";
import { personId, requireAdmin, userId } from "./access.ts";
import { countAccounts, getAuth, getSession, isSameOrigin, registerAccount } from "./auth.ts";
import { AVATAR_MAX_BYTES, clearAvatar, getAvatar, getUser, setAvatar, signInsOf } from "./data/users.ts";
import { getOidcSettings, oidcReady } from "./data/oidc.ts";
import { setUserAccent, setUserTalk, userTalk } from "./data/prefs.ts";
import { activeProfile } from "./data/profiles.ts";
import { approvalsRoutes } from "./routes/approvals.ts";
import { botsRoutes } from "./routes/bots.ts";
import { boxRoutes } from "./routes/box.ts";
import { connectionsRoutes } from "./routes/connections.ts";
import { eventsRoutes } from "./routes/events.ts";
import { exportsRoutes } from "./routes/exports.ts";
import { teachingsRoutes } from "./routes/teachings.ts";
import { spacesRoutes } from "./routes/spaces.ts";
import { llmProxyRoutes, providerRoutes } from "./routes/llm.ts";
import { mcpHandBack, mcpProxyRoutes, mcpRoutes } from "./routes/mcp.ts";
import { mobileSignInRoutes } from "./routes/mobile-sign-in.ts";
import { notifyRoutes } from "./routes/notify.ts";
import { profilesRoutes } from "./routes/profiles.ts";
import { pushRoutes } from "./routes/push.ts";
import { secretsRoutes } from "./routes/secrets.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { routinesRoutes } from "./routes/routines.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { threadsRoutes } from "./routes/threads.ts";
import { authConfig, usersRoutes } from "./routes/users.ts";
import { releaseRoutes } from "./routes/release.ts";
import { voiceRoutes } from "./routes/voice.ts";
import { callsRoutes } from "./routes/calls.ts";
import { usageRoutes } from "./routes/usage.ts";

export type Env = { Variables: { session: Session; profile?: string } };

export function createApp() {
  const app = new Hono<Env>();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const auth = await getAuth();
    return auth.handler(c.req.raw);
  });

  app.get("/api/account", async (c) => c.json({ accounts: await countAccounts() }));

  app.get("/api/auth-config", async (c) => c.json(authConfig((await countAccounts()) > 0)));

  app.post("/api/register", async (c) => {
    if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-site request blocked" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; username?: string; password?: string; confirm?: string };
    if (body.password !== body.confirm) return c.json({ error: "The passwords don't match." }, 400);
    const result = await registerAccount({ token: String(body.token ?? ""), username: String(body.username ?? ""), password: String(body.password ?? "") }, c.req.raw.headers);
    if (result.error) return c.json(result, 400);

    const auth = await getAuth();
    const signIn = await auth.api.signInUsername({ body: { username: String(body.username).trim().toLowerCase(), password: String(body.password) }, headers: c.req.raw.headers, asResponse: true });
    return signIn;
  });

  app.route("/", mobileSignInRoutes());
  app.use("/api/mcp-servers/oauth/callback", mcpHandBack);

  app.route("/api", mcpProxyRoutes());
  app.route("/api", llmProxyRoutes());

  app.use("/api/*", async (c, next) => {
    if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-site request blocked" }, 403);
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: "Sign in to continue" }, 401);
    c.set("session", session);
    c.set("profile", activeProfile(session.session.id, session.user.id));
    await next();
  });

  for (const path of ["/api/server/update", "/api/box/update", "/api/box/reset", "/api/onboarding/*", "/api/users", "/api/users/*", "/api/oidc", "/api/oidc/*"]) {
    app.use(path, requireAdmin);
  }
  app.on(["POST", "PATCH", "PUT", "DELETE"], ["/api/settings"], requireAdmin);

  // The person, as the open profile shows them: its picture, colour and talk, the person's own role.
  app.get("/api/me", (c) => {
    const person = getUser(personId(c));
    const user = getUser(userId(c));
    return person && user ? c.json({ user: { ...user, id: person.id, role: person.role } }) : c.json({ error: "Sign in to continue" }, 401);
  });

  app.get("/api/me/avatar", (c) => {
    const avatar = getAvatar(userId(c));
    if (!avatar) return c.json({ error: "There's no picture" }, 404);
    return new Response(Buffer.from(avatar.data), {
      headers: { "Content-Type": avatar.mediaType, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  });

  app.put("/api/me/avatar", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the picture as a file" }, 400);
    if (file.size > AVATAR_MAX_BYTES) return c.json({ error: "The picture must be under 2 MB" }, 413);
    try {
      const avatar = setAvatar(userId(c), new Uint8Array(await file.arrayBuffer()));
      return c.json({ avatar });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the picture" }, 400);
    }
  });

  app.delete("/api/me/avatar", (c) => {
    clearAvatar(userId(c));
    return c.body(null, 204);
  });

  app.get("/api/me/sign-ins", (c) => {
    const has = signInsOf(personId(c));
    const oidc = oidcReady() ? { name: getOidcSettings().name, linked: has.oidc } : null;
    return c.json({ password: has.password, oidc } satisfies SignIns);
  });

  app.put("/api/me/accent", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { accent?: unknown } | null;
    if (!isAccent(body?.accent)) return c.json({ error: "Pick one of the colors on offer" }, 400);
    setUserAccent(userId(c), body.accent);
    return c.json({ accent: body.accent });
  });

  app.put("/api/me/talk", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { style?: unknown; emoji?: unknown } | null;
    const talk = userTalk(userId(c));
    if (body?.style !== undefined && !isReplyStyle(body.style)) return c.json({ error: "Pick one of the styles on offer" }, 400);
    if (body?.emoji !== undefined && !isEmojiLevel(body.emoji)) return c.json({ error: "Pick more, default or less emoji" }, 400);
    const next = { style: isReplyStyle(body?.style) ? body.style : talk.style, emoji: isEmojiLevel(body?.emoji) ? body.emoji : talk.emoji };
    setUserTalk(userId(c), next);
    return c.json(next);
  });

  app.route("/api", profilesRoutes());
  app.route("/api", botsRoutes());
  app.route("/api", threadsRoutes());
  app.route("/api", approvalsRoutes());
  app.route("/api", routinesRoutes());
  app.route("/api", settingsRoutes());
  app.route("/api", connectionsRoutes());
  app.route("/api", boxRoutes());
  app.route("/api", eventsRoutes());
  app.route("/api", exportsRoutes());
  app.route("/api", teachingsRoutes());
  app.route("/api", spacesRoutes());
  app.route("/api", skillsRoutes());
  app.route("/api", mcpRoutes());
  app.route("/api", secretsRoutes());
  app.route("/api", providerRoutes());
  app.route("/api", voiceRoutes());
  app.route("/api", callsRoutes());
  app.route("/api", usageRoutes());
  app.route("/api", pushRoutes());
  app.route("/api", notifyRoutes());
  app.route("/api", usersRoutes());
  app.route("/api", releaseRoutes());

  app.notFound((c) => c.json({ error: "There's nothing at that address" }, 404));
  app.onError((error, c) => {
    console.error("[gond]", error);
    return c.json({ error: error.message || "Something went wrong. Try again in a moment." }, 500);
  });
  return app;
}
