import type { BoxStatus, ClaudeStatus, Engine } from "@gond/shared";
import { boxConfig, boxStats, boxVersions, checkClaude, claudeAuth, engineSignIn, health, listAgents, type BoxConfig, type BoxStats, type BoxVersions, type ClaudeCheck } from "./box.ts";
import { getUser } from "./data/users.ts";
import { emit } from "./events.ts";
import { composioConfigured } from "./composio.ts";
import { listConnections } from "./data/settings.ts";
import { isUpdating } from "./updater.ts";

const CHECK_CACHE_MS = 5 * 60 * 1000;
const cachedChecks = new Map<string, { at: number; check: ClaudeCheck }>();

async function checkClaudeCached(box: BoxConfig, { fresh = false } = {}): Promise<ClaudeCheck> {
  const key = box.user ?? "";
  const cached = cachedChecks.get(key);
  if (!fresh && cached && Date.now() - cached.at < CHECK_CACHE_MS) return cached.check;
  const check = await checkClaude(box);
  cachedChecks.set(key, { at: Date.now(), check });
  return check;
}

export function forgetClaudeCheck(userId?: string) {
  if (userId) {
    cachedChecks.delete(userId);
  } else {
    cachedChecks.clear();
  }
  cachedVersions = null;
}

/** Claude Code is installed and signed in on the computer for this person, as Settings → AI reads it. */
export async function claudeSignedIn(userId: string): Promise<boolean> {
  const box = boxConfig(userId);
  return box ? (await checkClaudeCached(box).catch(() => null))?.status === "ok" : false;
}

const watched = new Map<string, ReturnType<typeof setInterval>>();
const WATCH_MS = 3_000;
const WATCH_LIMIT_MS = 11 * 60 * 1000;

export function watchEngineSignIn(box: BoxConfig, userId: string, engine: Engine, intervalMs = WATCH_MS): void {
  const key = `${userId}:${engine}`;
  clearInterval(watched.get(key));
  const until = Date.now() + WATCH_LIMIT_MS;
  const stop = () => {
    clearInterval(watched.get(key));
    watched.delete(key);
  };
  const timer = setInterval(() => {
    if (Date.now() > until) return stop();
    void engineSignIn(box, engine)
      .then(({ signIn }) => {
        if (signIn && signIn.state !== "done" && signIn.state !== "failed") return;
        stop();

        if (signIn?.state === "done") forgetClaudeCheck(userId);
        emit({ topic: "ai", userId });
      })
      .catch(() => stop());
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  watched.set(key, timer);
}

let cachedVersions: { at: number; versions: BoxVersions } | null = null;

async function versionsCached(box: BoxConfig, fresh = false): Promise<BoxVersions | null> {
  if (!fresh && cachedVersions && Date.now() - cachedVersions.at < CHECK_CACHE_MS) return cachedVersions.versions;
  const versions = await boxVersions(box).catch(() => null);
  if (versions) cachedVersions = { at: Date.now(), versions };
  return versions;
}

async function claudeStatus(box: BoxConfig | null, fresh = false): Promise<ClaudeStatus> {
  if (!box) return { status: "no-box", detail: "No box is configured. Set GOND_BOX_URL." };
  try {
    const [check, auth] = await Promise.all([checkClaudeCached(box, { fresh }), claudeAuth(box).catch(() => null)]);
    return { status: check.status, detail: check.detail, email: auth?.email ?? null };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "The box didn't answer" };
  }
}

export async function boxStatus(userId: string, { fresh = false, admin = false } = {}): Promise<BoxStatus> {
  let box: BoxConfig | null = null;
  let configError: string | null = null;
  try {
    box = boxConfig(userId);
  } catch (error) {
    configError = error instanceof Error ? error.message : "bad box config";
  }
  const connections = listConnections(userId);
  if (!box) {
    return {
      configured: false,
      reachable: false,
      updating: false,
      claude: { status: "no-box", detail: configError ?? "No box is configured. Set GOND_BOX_URL." },
      composio: { configured: composioConfigured(userId), connected: connections.filter((c) => c.status === "active").length },
      agents: [],
      versions: null,
    };
  }
  let reachable = false;
  let updating = isUpdating();
  let agents: BoxStatus["agents"] = [];
  let versions: BoxVersions | null = null;
  let computer: BoxStatus["health"];
  try {
    const h = await health(box);
    reachable = true;
    updating = updating || Boolean(h.updating);
    if (!updating) {
      const all = (await listAgents(box).catch(() => ({ agents: [] }))).agents;
      agents = all.filter((a) => admin || a.user === userId).map(({ id, running, busy }) => ({ id, running, busy }));
      const [found, stats] = await Promise.all([versionsCached(box, fresh), admin ? boxStats(box).catch(() => null) : null]);
      versions = found;
      if (stats) computer = healthOf(stats);
    }
  } catch {
    reachable = false;
  }
  return {
    configured: true,
    reachable,
    updating,
    claude: updating ? { status: "error", detail: "The computer is updating." } : reachable ? await claudeStatus(box, fresh) : { status: "error", detail: "The box isn't reachable. Is the box container running?" },
    composio: { configured: composioConfigured(userId), connected: connections.filter((c) => c.status === "active").length },
    agents,
    versions,
    ...(computer ? { health: computer } : {}),
  };
}

/** The box's numbers with each account named for its person, and its profile when it isn't their default. */
export function healthOf(stats: BoxStats, at = new Date()): NonNullable<BoxStatus["health"]> {
  return {
    disk: stats.disk,
    memory: stats.memory,
    people: stats.people.map(({ id, bots, screens, memory, disk }) => {
      const user = getUser(id);
      const name = !user ? "Someone no longer on this Gond" : user.profile.isDefault ? user.name : `${user.name} · ${user.profile.label}`;
      return { id, name, bots, screens, memory, disk };
    }),
    diskAt: stats.diskAt,
    at: at.toISOString(),
  };
}
