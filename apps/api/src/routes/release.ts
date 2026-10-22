import { Hono } from "hono";
import type { Env } from "../app.ts";
import { serverUpdateReport, serverVersion, startServerUpdate } from "../release.ts";

export function releaseRoutes() {
  const app = new Hono<Env>();

  // Every page asks after reconnecting: a new version means the server was updated, so it reloads.
  app.get("/version", (c) => c.json({ version: serverVersion() }));

  app.get("/server/update", async (c) => c.json({ update: await serverUpdateReport(c.req.query("check") === "1") }));

  app.post("/server/update", async (c) => {
    const report = await serverUpdateReport();
    if (report.blocked) return c.json({ error: report.blocked }, 409);
    if (!report.available) return c.json({ error: "Gond is already up to date" }, 409);
    startServerUpdate();
    return c.json({ update: await serverUpdateReport() });
  });

  return app;
}
