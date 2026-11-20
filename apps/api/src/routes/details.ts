import { checkDetail } from "@gond/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { deleteDetail, getDetail, listDetails, saveDetail } from "../data/details.ts";
import { readBody } from "./body.ts";

/** Settings → Your details. A private field's value is never sent back, here or anywhere. */
export function detailsRoutes() {
  const app = new Hono<Env>();

  app.get("/details", (c) => c.json({ details: listDetails(userId(c)) }));

  app.post("/details", async (c) => {
    const checked = checkDetail(await readBody(c));
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    const saved = saveDetail(userId(c), checked.detail);
    return "error" in saved ? c.json({ error: saved.error }, 400) : c.json({ detail: saved });
  });

  app.put("/details/:id", async (c) => {
    if (!getDetail(userId(c), c.req.param("id"))) return c.json({ error: "Couldn't find those details" }, 404);
    const checked = checkDetail(await readBody(c));
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    const saved = saveDetail(userId(c), checked.detail, c.req.param("id"));
    return "error" in saved ? c.json({ error: saved.error }, 400) : c.json({ detail: saved });
  });

  app.delete("/details/:id", (c) => (deleteDetail(userId(c), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Couldn't find those details" }, 404)));

  return app;
}
