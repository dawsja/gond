import type { BoxUpdate, BoxUpdatePhase } from "@gond/shared";
import { boxConfig, boxUpdateStatus, forgetBoxAccounts, health, resetBox, startBoxUpdate, type BoxConfig } from "./box.ts";
import { dockerAvailability, DockerError, findBoxContainer, imageId, pullImage, recreateContainer } from "./docker.ts";
import { emit } from "./events.ts";
import { postMessage } from "./data/threads.ts";
import { activeTurns, forgetSouls, type StopCause } from "./responder.ts";
import { syncSkills } from "./skills.ts";
import { forgetClaudeCheck } from "./status.ts";

const holder = globalThis as typeof globalThis & { __gondBoxUpdate?: BoxUpdate };

const IDLE: BoxUpdate = { phase: "idle", startedAt: null, finishedAt: null, log: [], error: null, pulled: false, patched: false, kind: "update" };

const BOX_BACK_MS = 5 * 60 * 1000;

const PATCH_MS = 35 * 60 * 1000;
const MAX_LOG_LINES = 400;

export function boxUpdate(): BoxUpdate {
  return (holder.__gondBoxUpdate ??= { ...IDLE });
}

export function isUpdating(): boolean {
  const phase = boxUpdate().phase;
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function set(patch: Partial<BoxUpdate>) {
  holder.__gondBoxUpdate = { ...boxUpdate(), ...patch };
  emit({ topic: "box" });
}

function log(line: string) {
  const current = boxUpdate();
  const lines = [...current.log, ...line.split("\n").filter((l) => l.trim())].slice(-MAX_LOG_LINES);
  holder.__gondBoxUpdate = { ...current, log: lines };
  emit({ topic: "box" });
}

function phase(next: BoxUpdatePhase, note?: string) {
  set({ phase: next });
  if (note) log(note);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBox(box: BoxConfig, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const h = await health(box);
      if (h.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(2_000);
  }
  throw new Error("The box didn't come back in time. Check `docker compose logs box`.");
}

async function pause(): Promise<string[]> {
  const turns = activeTurns();
  const threads = new Set<string>();
  for (const turn of turns.values()) {
    threads.add(turn.threadId);
    turn.controller.abort("updating" satisfies StopCause);
  }
  const until = Date.now() + 15_000;
  while (turns.size > 0 && Date.now() < until) await sleep(500);
  for (const threadId of threads) {
    postMessage({ threadId, author: "system", kind: "event", body: "The computer is updating. What was running stopped, and it carries on once the computer is back.", answered: true });
  }
  log(turns.size ? `${turns.size} turn(s) didn't stop in time; going on.` : threads.size ? `Stopped work in ${threads.size} conversation(s).` : "No bot was working.");
  return [...threads];
}

async function pullNewer(): Promise<{ newer: boolean; image: string; info: Awaited<ReturnType<typeof findBoxContainer>> } | null> {
  const docker = dockerAvailability();
  if (!docker.available) {
    log(`Skipping the image pull: ${docker.reason}`);
    return null;
  }
  const info = await findBoxContainer();
  const image = info.Config.Image;
  log(`Box container ${info.Name.replace(/^\//, "")} runs ${image}.`);
  const before = info.Image;
  await pullImage(image, log);
  const after = await imageId(image);
  const newer = Boolean(after && after !== before);
  log(newer ? `A newer image arrived (${after!.slice(7, 19)}).` : "The image is already the newest.");
  return { newer, image, info };
}

async function patchInPlace(box: BoxConfig): Promise<boolean> {
  await startBoxUpdate(box);
  let shown = 0;
  const until = Date.now() + PATCH_MS;
  while (Date.now() < until) {
    await sleep(2_000);
    let status;
    try {
      status = await boxUpdateStatus(box);
    } catch {
      continue;
    }
    const text = status.log ?? "";
    if (text.length > shown) {
      log(text.slice(shown));
      shown = text.length;
    }
    if (!status.running) return status.ok === true;
  }
  log("The patch is taking too long; leaving it to finish on its own.");
  return false;
}

async function run(options: { pull: boolean }): Promise<void> {
  const box = boxConfig();
  if (!box) throw new Error("The computer isn't set up. Set GOND_BOX_URL on the API.");
  try {
    phase("pausing", "Pausing the computer…");
    const stopped = await pause();

    let pulled = false;
    if (options.pull) {
      phase("pulling", "Looking for a newer box image…");
      const result = await pullNewer();
      if (result?.newer) {
        phase("restarting", "Recreating the box on the new image (its volumes stay)…");
        await recreateContainer(result.info, result.image, log);
        log("Waiting for the box to come back…");
        await waitForBox(box, BOX_BACK_MS);
        pulled = true;
        set({ pulled: true });
      }
    }

    phase("patching", "Patching the box in place: Debian, Bun, Claude Code…");
    const patched = await patchInPlace(box);
    set({ patched });

    phase("resuming", "Bringing the computer back…");
    await waitForBox(box, 60_000);
    forgetClaudeCheck();
    set({ phase: "done", finishedAt: new Date().toISOString() });
    log(pulled ? "Updated to the newest image and patched. The bots are back." : patched ? "Patched. The bots are back." : "Finished with warnings; the bots are back.");
    for (const threadId of stopped) postMessage({ threadId, author: "system", kind: "event", body: "The computer is back.", answered: true });
  } catch (error) {
    const message = error instanceof DockerError || error instanceof Error ? error.message : "The update failed.";
    set({ phase: "failed", finishedAt: new Date().toISOString(), error: message });
    log(`Failed: ${message}`);
  }
}

export function startUpdate(options: { pull?: boolean } = {}): BoxUpdate {
  if (isUpdating()) return boxUpdate();
  holder.__gondBoxUpdate = { ...IDLE, log: [], startedAt: new Date().toISOString(), kind: "update" };
  emit({ topic: "box" });
  void run({ pull: options.pull ?? true });
  return boxUpdate();
}

/** Updates the computer to the end, as part of Gond's own update; true when it finished. */
export async function updateComputer(): Promise<boolean> {
  if (isUpdating()) return false;
  holder.__gondBoxUpdate = { ...IDLE, log: [], startedAt: new Date().toISOString(), kind: "update" };
  emit({ topic: "box" });
  await run({ pull: true });
  return boxUpdate().phase === "done";
}

export function startReset(): BoxUpdate {
  if (isUpdating()) return boxUpdate();
  holder.__gondBoxUpdate = { ...IDLE, log: [], startedAt: new Date().toISOString(), kind: "reset" };
  emit({ topic: "box" });
  void runReset();
  return boxUpdate();
}

async function runReset(): Promise<void> {
  const box = boxConfig();
  if (!box) throw new Error("The computer isn't set up. Set GOND_BOX_URL on the API.");
  try {
    phase("pausing", "Pausing the computer…");
    const stopped = await pause();
    phase("resetting", "Wiping the computer (only the Claude Code sign-ins stay)…");
    const result = await resetBox(box);

    forgetBoxAccounts();
    log(result.removed.length ? `Removed from the admin's home: ${result.removed.join(", ")}.` : "The admin's home was already empty.");
    log(result.accounts.length ? `Accounts removed: ${result.accounts.join(", ")}. Each is made again, empty, the next time that person uses the computer.` : "No other accounts to remove.");
    const docker = dockerAvailability();
    if (docker.available) {
      log("Rebuilding the container from its image…");
      const info = await findBoxContainer();
      await recreateContainer(info, info.Config.Image, log);
      log("Waiting for the box to come back…");
      await waitForBox(box, BOX_BACK_MS);
    } else {
      log(`Container not rebuilt: ${docker.reason}`);
    }
    phase("resuming", "Bringing the computer back…");
    await waitForBox(box, 60_000);
    forgetClaudeCheck();

    forgetSouls();
    log("Writing the skills library back…");
    await syncSkills();
    set({ phase: "done", finishedAt: new Date().toISOString() });
    log("Reset. The computer is as it was built; the bots are back with empty homes.");
    for (const threadId of stopped) postMessage({ threadId, author: "system", kind: "event", body: "The computer is back.", answered: true });
  } catch (error) {
    const message = error instanceof DockerError || error instanceof Error ? error.message : "The reset failed.";
    set({ phase: "failed", finishedAt: new Date().toISOString(), error: message });
    log(`Failed: ${message}`);
  }
}

export function updateReport(): { update: BoxUpdate; docker: ReturnType<typeof dockerAvailability> } {
  return { update: boxUpdate(), docker: dockerAvailability() };
}
