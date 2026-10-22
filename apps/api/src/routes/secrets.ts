import { Hono } from "hono";
import { ownThread, userId } from "../access.ts";
import { applyComposioKey } from "../composio.ts";
import type { Env } from "../app.ts";
import { changeSecret, deleteSecret, getSecretRequest, listSecrets, resolveSecretRequest, setSecret } from "../data/secrets.ts";
import { listThreads } from "../data/threads.ts";
import { forgetHeldLogin, holdLogin, rememberable } from "../logins.ts";
import { answerSecretRequest } from "../secret-requests.ts";

export function secretsRoutes() {
  const app = new Hono<Env>();

  app.get("/secret-requests/:id", (c) => {
    const request = getSecretRequest(c.req.param("id"));
    return request && ownThread(c, request.threadId) ? c.json({ request }) : c.json({ error: "Couldn't find that request" }, 404);
  });

  app.post("/secret-requests/:id", async (c) => {
    const request = getSecretRequest(c.req.param("id"));
    if (!request || !ownThread(c, request.threadId)) return c.json({ error: "Couldn't find that request" }, 404);
    if (request.status !== "pending") return c.json({ request });
    const body = (await c.req.json().catch(() => ({}))) as { value?: string; values?: Record<string, unknown>; remember?: boolean; decline?: boolean };
    if (body.decline) return c.json({ request: answerSecretRequest(request.id, "declined") });
    try {
      if (request.target === "login") {
        const values = body.values && typeof body.values === "object" ? body.values : {};
        const given = request.fields.map((field) => ({ field, value: typeof values[field.name] === "string" ? (values[field.name] as string) : "" }));
        if (given.some(({ value }) => !value)) return c.json({ error: "Fill in every field" }, 400);
        if (given.some(({ value }) => value.length > 1_000)) return c.json({ error: "That's too long" }, 400);
        for (const { field, value } of given) {
          holdLogin(request.threadId, field.name, value);
          if (body.remember === true && rememberable(field)) setSecret(userId(c), field.name, value, request.botId, request.site ?? request.name);
        }
      } else if (request.target === "composio") applyComposioKey(userId(c), String(body.value ?? ""));
      else setSecret(userId(c), request.name, String(body.value ?? ""), request.botId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    return c.json({ request: answerSecretRequest(request.id, "given") ?? resolveSecretRequest(request.id, "given") });
  });

  app.get("/secrets", (c) => c.json({ secrets: listSecrets(userId(c)) }));

  // The person replaces a value they already have; nobody ever reads one back, here or anywhere.
  app.put("/secrets/:name", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value !== "string" || !body.value) return c.json({ error: "Type the new value" }, 400);
    if (body.value.length > 8_000) return c.json({ error: "That's too long" }, 400);
    const name = c.req.param("name");
    if (!changeSecret(userId(c), name, body.value)) return c.json({ error: "Couldn't find that secret" }, 404);
    forgetHeldLogin(name, listThreads({ userId: userId(c) }).map((t) => t.id));
    return c.json({ ok: true });
  });

  app.delete("/secrets/:name", (c) => (deleteSecret(userId(c), c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "Couldn't find that secret" }, 404)));

  return app;
}
