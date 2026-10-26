import { SPACE_LEVELS, type SpaceInvitePreview, type SpaceLevel } from "@gond/shared";
import { Hono, type Context } from "hono";
import { admin, ownThread, requireAdmin, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { listBots } from "../data/bots.ts";
import { federationRow, listPeers, saveFederation, setPeerChecked, setSpaceDefaults, spaceDefaults, spacesWith } from "../data/spaces.ts";
import { emit } from "../events.ts";
import { federationFor, flush, startFederation } from "../federation.ts";
import { allowKnownGonds, announceGond, blockGond, changeRule, closeAllSpaces, createInvite, joinSpace, leaveSpace, previewInvite, currentRule, spaceDetails, SpaceError, startSpace, type InviteDays } from "../spaces.ts";
import { keyWords } from "../words.ts";

/** Spaces: this Gond among others (the admin's), each person's defaults, invites, joining and each space's rules. */
export function spacesRoutes() {
  const app = new Hono<Env>();

  const failed = (c: Context<Env>, error: unknown) => {
    if (error instanceof SpaceError) return c.json({ error: error.message }, error.status);
    console.error("[gond] a space request failed:", error);
    return c.json({ error: error instanceof Error && /relay/i.test(error.message) ? error.message : "Something went wrong. Try again in a moment." }, 500);
  };
  const body = async (c: Context<Env>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const canInvite = (c: Context<Env>) => federationFor(admin(c)).canInvite;

  app.get("/spaces/federation", (c) => c.json({ federation: federationFor(admin(c)), peers: admin(c) ? listPeers(userId(c)) : [] }));

  app.put("/spaces/federation", requireAdmin, async (c) => {
    const given = await body(c);
    const before = federationRow();
    const patch: Parameters<typeof saveFederation>[0] = {};
    if (given.enabled !== undefined) {
      if (typeof given.enabled !== "boolean") return c.json({ error: "Spaces are on or off" }, 400);
      patch.enabled = given.enabled ? 1 : 0;
    }
    if (given.name !== undefined) {
      const name = String(given.name).trim();
      if (!name || name.length > 60) return c.json({ error: "Give this Gond a name of up to 60 characters" }, 400);
      patch.name = name;
    }
    if (given.relay !== undefined) {
      if (given.relay !== "gond" && given.relay !== "own") return c.json({ error: "Pick Gond's relay or your own" }, 400);
      patch.relay = given.relay;
    }
    if (given.relayUrl !== undefined) {
      const url = String(given.relayUrl).trim().replace(/\/$/, "");
      if (url && !/^https?:\/\/[^\s]+$/.test(url)) return c.json({ error: "The relay's address starts with https://" }, 400);
      patch.relay_url = url;
    }
    if ((patch.relay ?? before.relay) === "own" && !(patch.relay_url ?? before.relay_url)) return c.json({ error: "Add your relay's address" }, 400);
    if (given.invites !== undefined) {
      if (given.invites !== "everyone" && given.invites !== "admin") return c.json({ error: "Pick who can invite" }, 400);
      patch.invites = given.invites;
    }
    if ((patch.enabled ?? before.enabled) && !(patch.name ?? before.name).trim()) return c.json({ error: "Give this Gond a name others will see" }, 400);
    if (before.enabled && patch.enabled === 0) {
      // Off closes every space here, and the other Gonds hear so before this one goes quiet.
      closeAllSpaces();
      await flush().catch(() => undefined);
    }
    saveFederation(patch);
    const after = federationRow();
    const moved = after.relay !== before.relay || after.relay_url !== before.relay_url;
    if (after.enabled !== before.enabled || moved) {
      await startFederation();
      if (after.enabled) void allowKnownGonds().catch(() => undefined);
    }
    if (after.enabled && (moved || after.name !== before.name)) announceGond();
    emit({ topic: "spaces" });
    return c.json({ federation: federationFor(true), peers: listPeers(userId(c)) });
  });

  app.get("/spaces/defaults", (c) => c.json({ defaults: spaceDefaults(userId(c)) }));

  app.put("/spaces/defaults", async (c) => {
    const given = await body(c);
    if (!SPACE_LEVELS.includes(given.level as SpaceLevel)) return c.json({ error: "Pick what your bots may do" }, 400);
    const mine = new Set(listBots({ userId: userId(c) }).map((b) => b.id));
    const bots = given.bots === null ? null : Array.isArray(given.bots) ? [...new Set(given.bots.map(String))].filter((id) => mine.has(id)) : undefined;
    if (bots === undefined) return c.json({ error: "Pick which bots may join spaces" }, 400);
    setSpaceDefaults(userId(c), { level: given.level as SpaceLevel, bots });
    emit({ topic: "spaces", userId: userId(c) });
    return c.json({ defaults: spaceDefaults(userId(c)) });
  });

  app.post("/spaces", async (c) => {
    const given = await body(c);
    if (!canInvite(c)) return c.json({ error: "Only the admin can start spaces on this Gond" }, 403);
    const botIds = Array.isArray(given.botIds) ? given.botIds.map(String) : [];
    try {
      return c.json({ thread: await startSpace(userId(c), String(given.name ?? ""), botIds) }, 201);
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/spaces/invites", async (c) => {
    const given = await body(c);
    if (!canInvite(c)) return c.json({ error: "Only the admin can invite people from other Gonds here" }, 403);
    const thread = ownThread(c, String(given.threadId ?? ""));
    if (!thread) return c.json({ error: "Couldn't find that room" }, 404);
    const days = Number(given.days ?? 7);
    if (![1, 7, 30].includes(days)) return c.json({ error: "An invite lasts a day, a week or 30 days" }, 400);
    try {
      return c.json({ invite: await createInvite(thread, days as InviteDays) }, 201);
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/spaces/preview", async (c) => {
    const given = await body(c);
    if (!canInvite(c)) return c.json({ error: "Only the admin can join spaces from this Gond" }, 403);
    try {
      const invite = previewInvite(String(given.link ?? ""));
      const preview: SpaceInvitePreview = { name: invite.name, host: { key: invite.host.key, name: invite.host.name, words: keyWords(invite.host.key) }, members: invite.members.map((m) => ({ name: m.name, kind: m.kind, color: m.color })), expires: new Date(invite.expires).toISOString() };
      return c.json({ preview });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/spaces/join", async (c) => {
    const given = await body(c);
    if (!canInvite(c)) return c.json({ error: "Only the admin can join spaces from this Gond" }, 403);
    const botIds = Array.isArray(given.botIds) ? given.botIds.map(String) : [];
    try {
      return c.json({ thread: await joinSpace(userId(c), String(given.link ?? ""), botIds) }, 201);
    } catch (error) {
      return failed(c, error);
    }
  });

  app.get("/spaces/threads/:id", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    const space = thread ? spaceDetails(thread) : null;
    return space ? c.json({ space }) : c.json({ error: "Couldn't find that space" }, 404);
  });

  app.put("/spaces/threads/:id/rules/:botId", async (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "Couldn't find that space" }, 404);
    const given = await body(c);
    const optional = (value: unknown) => value === undefined || typeof value === "boolean";
    if (!SPACE_LEVELS.includes(given.level as SpaceLevel) || typeof given.memory !== "boolean" || typeof given.botsWake !== "boolean" || !optional(given.relay) || !optional(given.peopleWake)) return c.json({ error: "Pick what this bot may do here" }, 400);
    try {
      // A page from before a switch doesn't send it, and leaves it as it was.
      const now = currentRule(thread, c.req.param("botId"));
      const relay = typeof given.relay === "boolean" ? given.relay : (now?.relay ?? false);
      const peopleWake = typeof given.peopleWake === "boolean" ? given.peopleWake : (now?.peopleWake ?? true);
      changeRule(thread, { botId: c.req.param("botId"), level: given.level as SpaceLevel, memory: given.memory, peopleWake, botsWake: given.botsWake, relay });
      return c.json({ space: spaceDetails(thread) });
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post("/spaces/threads/:id/leave", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread || !spaceDetails(thread)) return c.json({ error: "Couldn't find that space" }, 404);
    leaveSpace(thread);
    return c.json({ space: spaceDetails(thread) });
  });

  // Saying the words matched is each person's own say, for a Gond they share a space with: it never marks it checked for anyone else.
  app.post("/spaces/gonds/:key/verify", async (c) => {
    const key = c.req.param("key") ?? "";
    if (!admin(c) && !spacesWith(key).some((s) => s.user_id === userId(c))) return c.json({ error: "Couldn't find that Gond" }, 404);
    const given = await body(c);
    setPeerChecked(userId(c), key, given.verified !== false);
    emit({ topic: "spaces", userId: userId(c) });
    return c.json({ ok: true });
  });

  app.post("/spaces/gonds/:key/block", requireAdmin, async (c) => {
    const given = await body(c);
    if (typeof given.blocked !== "boolean") return c.json({ error: "Blocked is on or off" }, 400);
    await blockGond(c.req.param("key") ?? "", given.blocked);
    emit({ topic: "spaces" });
    return c.json({ peers: listPeers(userId(c)) });
  });

  return app;
}
