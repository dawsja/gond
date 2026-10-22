import { newerVersion, type ServerUpdate, type ServerUpdatePhase } from "@gond/shared";
import { env } from "./config.ts";
import { dockerAvailability, DockerError, findServiceContainer, imageId, pullImage, recreateContainer, replaceSelf, selfContainer } from "./docker.ts";
import { boxUpdate, isUpdating, updateComputer } from "./updater.ts";

const REPO = "dawsja/gond";
// GitHub answers 60 unsigned requests an hour per address; About is opened far less often than this.
const CHECK_MS = 10 * 60_000;
const MAX_NOTES = 6;

type Latest = { at: number; latest: string | null; notes: string[] };

const holder = globalThis as typeof globalThis & { __gondRelease?: Latest; __gondServerUpdate?: { phase: ServerUpdatePhase; error: string | null } };

/** The release this server runs, from the image (`GOND_VERSION`); "dev" for anything built otherwise. */
export function serverVersion(): string {
  const version = (env("VERSION") ?? "").trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(version) ? version : "dev";
}

async function github<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "gond" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as T;
}

/** The commit subjects between two releases, newest first: they are written for the person reading the log. */
export function releaseNotes(messages: string[]): string[] {
  return messages
    .map((message) => message.split("\n")[0]!.trim())
    .filter((line) => line && !/^Merge\b/.test(line))
    .reverse()
    .slice(0, MAX_NOTES);
}

/** The newest release and what it brings over this one, looked up at most every ten minutes unless `force`d. */
export async function latestRelease(force = false): Promise<Latest> {
  const cached = holder.__gondRelease;
  if (!force && cached && Date.now() - cached.at < CHECK_MS) return cached;
  let latest: string | null = null;
  let notes: string[] = [];
  try {
    latest = (await github<{ tag_name: string }>("/releases/latest")).tag_name.replace(/^v/, "");
    const current = serverVersion();
    if (newerVersion(latest, current)) {
      const compare = await github<{ commits: { commit: { message: string } }[] }>(`/compare/v${current}...v${latest}`).catch(() => null);
      notes = releaseNotes((compare?.commits ?? []).map((c) => c.commit.message));
    }
  } catch (error) {
    console.warn(`[gond] couldn't check for a new release: ${error instanceof Error ? error.message : error}`);
  }
  holder.__gondRelease = { at: Date.now(), latest, notes };
  return holder.__gondRelease;
}

function state() {
  return (holder.__gondServerUpdate ??= { phase: "idle", error: null });
}

function set(phase: ServerUpdatePhase, error: string | null = null) {
  holder.__gondServerUpdate = { phase, error };
}

function blocked(): string | null {
  if (serverVersion() === "dev") return "This server wasn't installed from a release, so it updates the way it was built.";
  const docker = dockerAvailability();
  return docker.available ? null : docker.reason;
}

export async function serverUpdateReport(force = false): Promise<ServerUpdate> {
  const { latest, notes } = await latestRelease(force);
  const current = serverVersion();
  return { current, latest, available: Boolean(latest && newerVersion(latest, current)), notes, blocked: blocked(), ...state() };
}

const running = (phase: ServerUpdatePhase) => phase !== "idle" && phase !== "done" && phase !== "failed";

/**
 * Updates Gond in place: pulls the new images, updates the computer as Team → Update does, recreates
 * the web container, and last hands the API's own replacement to a helper container. Every page
 * reloads itself once the new API answers with its version.
 */
export function startServerUpdate(): ServerUpdate["phase"] {
  if (running(state().phase) || isUpdating()) return state().phase;
  set("pulling");
  void (async () => {
    try {
      const self = await selfContainer();
      const web = await findServiceContainer("web");
      for (const info of [self, web]) await pullImage(info.Config.Image, () => undefined);
      set("computer");
      if (!(await updateComputer())) throw new Error(boxUpdate().error ?? "The computer didn't update.");
      set("web");
      if ((await imageId(web.Config.Image)) !== web.Image) await recreateContainer(web, web.Config.Image, (line) => console.info(`[gond] ${line}`));
      if ((await imageId(self.Config.Image)) === self.Image) return set("done");
      set("server");
      await replaceSelf(self);
    } catch (error) {
      const message = error instanceof DockerError || error instanceof Error ? error.message : "The update failed.";
      console.warn(`[gond] the update failed: ${message}`);
      set("failed", message);
    }
  })();
  return state().phase;
}
