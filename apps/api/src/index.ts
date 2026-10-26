import { createApp } from "./app.ts";
import { getAuth } from "./auth.ts";
import { apiPort } from "./config.ts";
import { ensureDatabase } from "./db/init.ts";
import { startDispatcher } from "./dispatcher.ts";
import { syncSkills } from "./skills.ts";
import { resumeTeachings } from "./teach.ts";
import { startFederation } from "./federation.ts";
import { allowKnownGonds, startSpaces } from "./spaces.ts";
import { callSocket, upgradeCallSocket, type CallSocketData } from "./routes/calls.ts";

ensureDatabase();
await getAuth();
void syncSkills();
startDispatcher();
void resumeTeachings().catch((error: unknown) => console.error("[gond] picking up Show me how failed:", error));
startSpaces();
void startFederation()
  .then(() => allowKnownGonds())
  .catch((error: unknown) => console.error("[gond] connecting to other Gonds failed:", error));

const app = createApp();
const server = Bun.serve<CallSocketData>({
  port: apiPort(),
  hostname: process.env.HOST || "0.0.0.0",
  async fetch(request, server) {
    const upgraded = await upgradeCallSocket(request, server);
    return upgraded === null ? app.fetch(request) : upgraded;
  },
  websocket: callSocket,

  idleTimeout: 0,
});
console.info(`[gond] API listening on http://${server.hostname}:${server.port}`);
