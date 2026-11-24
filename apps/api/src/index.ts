import { createApp } from "./app.ts";
import { getAuth } from "./auth.ts";
import { apiPort } from "./config.ts";
import { ensureDatabase } from "./db/init.ts";
import { checkpointAndCloseDb } from "./db/sqlite.ts";
import { forgetEndedSessions } from "./data/profiles.ts";
import { startDispatcher, stopDispatcher } from "./dispatcher.ts";
import { watchSetupCards } from "./setup-cards.ts";
import { startUsageSharing, stopUsageSharing } from "./usage-sharing.ts";
import { syncSkills } from "./skills.ts";
import { startMemoryMoves } from "./memory-moves.ts";
import { resumeTeachings } from "./teach.ts";
import { startFederation, stopFederation } from "./federation.ts";
import { allowKnownGonds, startSpaces } from "./spaces.ts";

ensureDatabase();
await getAuth();
forgetEndedSessions();
void syncSkills();
startMemoryMoves();
startDispatcher();
watchSetupCards();
startUsageSharing();
void resumeTeachings().catch((error: unknown) => console.error("[gond] picking up Show me how failed:", error));
startSpaces();
void startFederation()
  .then(() => allowKnownGonds())
  .catch((error: unknown) => console.error("[gond] connecting to other Gonds failed:", error));

const app = createApp();
const server = Bun.serve({
  port: apiPort(),
  hostname: process.env.HOST || "0.0.0.0",
  fetch: app.fetch,

  idleTimeout: 0,
});
console.info(`[gond] API listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[gond] Received ${signal}, shutting down…`);
  // Hard ceiling so a wedged connection can never outlast Docker's stop grace period.
  const force = setTimeout(() => {
    checkpointAndCloseDb();
    process.exit(0);
  }, 5_000);
  force.unref?.();
  try {
    stopDispatcher();
    stopUsageSharing();
    stopFederation();
    await Promise.race([server.stop(false), Bun.sleep(3_000)]);
  } catch (error) {
    console.warn(`[gond] Error while shutting down: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(force);
    checkpointAndCloseDb();
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
