import { createApp } from "./app.ts";
import { getAuth } from "./auth.ts";
import { apiPort } from "./config.ts";
import { ensureDatabase } from "./db/init.ts";
import { startDispatcher } from "./dispatcher.ts";
import { syncSkills } from "./skills.ts";

ensureDatabase();
await getAuth();
void syncSkills();
startDispatcher();

const app = createApp();
const server = Bun.serve({
  port: apiPort(),
  hostname: process.env.HOST || "0.0.0.0",
  fetch: app.fetch,

  idleTimeout: 0,
});
console.info(`[gond] API listening on http://${server.hostname}:${server.port}`);
