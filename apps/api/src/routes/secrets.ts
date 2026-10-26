import { cardBrand, cardLabel, checkCard, coverLogin, looseCards, type CardDetails } from "@gond/shared";
import { Hono } from "hono";
import { ownsThread, userId } from "../access.ts";
import { applyComposioKey } from "../composio.ts";
import type { Env } from "../app.ts";
import { changeSecret, deleteSecret, getSecretRequest, listSecrets, readCard, readLogin, readSecret, resolveSecretRequest, saveCard, setSecret } from "../data/secrets.ts";
import { threadRefs } from "../data/threads.ts";
import { forgetHeldLogin, holdCard, holdLogin, rememberable } from "../logins.ts";
import { answerSecretRequest } from "../secret-requests.ts";

export function secretsRoutes() {
  const app = new Hono<Env>();

  app.get("/secret-requests/:id", (c) => {
    const request = getSecretRequest(c.req.param("id"));
    return request && ownsThread(c, request.threadId) ? c.json({ request }) : c.json({ error: "Couldn't find that request" }, 404);
  });

  app.post("/secret-requests/:id", async (c) => {
    const request = getSecretRequest(c.req.param("id"));
    if (!request || !ownsThread(c, request.threadId)) return c.json({ error: "Couldn't find that request" }, 404);
    if (request.status !== "pending") return c.json({ request });
    const body = (await c.req.json().catch(() => ({}))) as { value?: string; values?: Record<string, unknown>; saved?: unknown; remember?: boolean; decline?: boolean; card?: Record<string, unknown>; nickname?: unknown };
    if (body.decline) return c.json({ request: answerSecretRequest(request.id, "declined") });
    if (request.target === "card") {
      // A saved card the person picked, or one typed in now; either way only this conversation holds it, for a few minutes.
      let picked: { card: CardDetails; label: string } | null = null;
      if (typeof body.saved === "string") {
        const saved = readCard(userId(c), body.saved);
        if (!saved) return c.json({ error: "Couldn't find that card" }, 404);
        picked = { card: saved.card, label: cardLabel(saved.meta) };
      } else {
        const checked = checkCard(body.card ?? {});
        if ("error" in checked) return c.json({ error: checked.error }, 400);
        const card = checked.card as CardDetails;
        const nickname = typeof body.nickname === "string" ? body.nickname : "";
        if (body.remember === true) {
          const name = saveCard(userId(c), card, nickname);
          const saved = readCard(userId(c), name);
          picked = { card, label: saved ? cardLabel(saved.meta) : nickname };
        } else picked = { card, label: cardLabel({ nickname, brand: cardBrand(card.number), last4: card.number.slice(-4), expires: card.expiry }) };
      }
      holdCard(request.threadId, picked.card);
      return c.json({ request: answerSecretRequest(request.id, "given", picked.label) ?? resolveSecretRequest(request.id, "given", picked.label) });
    }
    try {
      if (request.target === "login") {
        const values = body.values && typeof body.values === "object" ? body.values : {};
        // A saved sign-in the person picked fills what it covers; its values never leave the API.
        const site = typeof body.saved === "string" ? body.saved : null;
        const savedNames = site ? listSecrets(userId(c)).filter((s) => s.site === site).map((s) => s.name) : [];
        if (site && !savedNames.length) return c.json({ error: "Couldn't find that saved sign-in" }, 404);
        const fromSaved = coverLogin(request.fields, savedNames);
        const given = request.fields.map((field) => {
          const saved = fromSaved.get(field.name);
          if (saved) return { field, value: readLogin(userId(c), saved) ?? "", saved: true };
          return { field, value: typeof values[field.name] === "string" ? (values[field.name] as string) : "", saved: false };
        });
        if (given.some(({ value }) => !value)) return c.json({ error: "Fill in every field" }, 400);
        if (given.some(({ value }) => value.length > 1_000)) return c.json({ error: "That's too long" }, 400);
        for (const { field, value, saved } of given) {
          holdLogin(request.threadId, field.name, value);
          if (!saved && body.remember === true && rememberable(field)) setSecret(userId(c), field.name, value, request.botId, request.site ?? request.name);
        }
      } else if (request.target === "composio") applyComposioKey(userId(c), String(body.value ?? ""));
      else if (request.replaces) {
        const value = String(body.value ?? "");
        // Replaced in place, so a saved sign-in keeps its site; what a conversation held of the old one goes.
        if (!value || value.length > 8_000) return c.json({ error: value ? "That's too long" : "Type the new value" }, 400);
        if (!changeSecret(userId(c), request.name, value)) setSecret(userId(c), request.name, value, request.botId);
        forgetHeldLogin(request.name, threadRefs(userId(c)).map((t) => t.id));
      } else setSecret(userId(c), request.name, String(body.value ?? ""), request.botId);
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
    forgetHeldLogin(name, threadRefs(userId(c)).map((t) => t.id));
    return c.json({ ok: true });
  });

  app.post("/cards", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { card?: Record<string, unknown>; nickname?: unknown };
    const checked = checkCard(body.card ?? {});
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    const name = saveCard(userId(c), checked.card as CardDetails, typeof body.nickname === "string" ? body.nickname : "");
    return c.json({ name });
  });

  // A field left empty keeps what the card had; nothing of it is ever sent back.
  app.put("/cards/:name", async (c) => {
    const name = c.req.param("name");
    const saved = readCard(userId(c), name);
    if (!saved) return c.json({ error: "Couldn't find that card" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { card?: Record<string, unknown>; nickname?: unknown };
    const checked = checkCard(body.card ?? {}, true);
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    saveCard(userId(c), { ...saved.card, ...checked.card }, typeof body.nickname === "string" ? body.nickname : saved.meta.nickname, name);
    return c.json({ ok: true });
  });

  // Keys that are one card split up, as bots asked for them before there were cards, become one card.
  app.post("/cards/combine", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prefix?: unknown };
    const me = userId(c);
    const group = looseCards(listSecrets(me).filter((s) => !s.card && !s.site).map((s) => s.name)).find((g) => g.prefix === body.prefix);
    if (!group) return c.json({ error: "Couldn't find those keys" }, 404);
    const values = Object.fromEntries(Object.entries(group.parts).map(([part, name]) => [part, readSecret(me, name!) ?? ""]));
    const checked = checkCard(values);
    if ("error" in checked) return c.json({ error: `Those keys don't make a card: ${checked.error}` }, 400);
    const words = group.prefix.replace(/_?CARD$/, "").replace(/_/g, " ").trim().toLowerCase();
    const name = saveCard(me, checked.card as CardDetails, words ? `${words[0]!.toUpperCase()}${words.slice(1)} card` : "");
    for (const old of Object.values(group.parts)) deleteSecret(me, old!);
    return c.json({ name });
  });

  app.delete("/secrets/:name", (c) => (deleteSecret(userId(c), c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "Couldn't find that secret" }, 404)));

  return app;
}
