import { cardBrand, cardLabel, checkCard, type CardDetails } from "@gond/shared";
import { Hono } from "hono";
import { ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { approveCheckout, cancelCheckout, checkoutRecord, setCheckoutAddress, shoppingRecord, startCheckout, trackingChecked } from "../data/shopping.ts";
import { readCard, saveCard } from "../data/secrets.ts";
import { wakeCheckout } from "../shopping.ts";
import { readBody } from "./body.ts";

export function shoppingRoutes() {
  const app = new Hono<Env>();
  app.onError((error, c) => c.json({ error: error instanceof Error ? error.message : "Shopping failed" }, 400));
  app.get("/shopping/:id", c => {
    try { return c.json({ record: shoppingRecord(c.req.param("id"), userId(c)) }); }
    catch { return c.json({ error: "Couldn't find that shopping card" }, 404); }
  });
  app.post("/shopping/:id/checkout", async c => {
    const body = await readBody(c);
    if (typeof body.actionKey !== "string" || body.actionKey.length > 100) return c.json({ error: "Missing action key" }, 400);
    const record = startCheckout(userId(c), c.req.param("id"), { productId: String(body.productId), variantId: String(body.variantId), offerId: String(body.offerId), quantity: Number(body.quantity), actionKey: body.actionKey });
    return c.json({ record });
  });
  app.post("/shopping/:id/address", async c => {
    const body = await readBody(c);
    const record = setCheckoutAddress(c.req.param("id"), userId(c), Number(body.revision), body.address);
    wakeCheckout(record.botId, record.threadId, record.id);
    return c.json({ record });
  });
  app.post("/shopping/:id/cancel", async c => {
    const body = await readBody(c);
    return c.json({ record: cancelCheckout(c.req.param("id"), userId(c), Number(body.revision)) });
  });
  app.post("/shopping/:id/approve", async c => {
    const body = await readBody(c), me = userId(c);
    const checkout = checkoutRecord(c.req.param("id"), me);
    if (!ownsThread(c, checkout.threadId)) return c.json({ error: "Couldn't find that checkout" }, 404);
    let card: CardDetails, label: string;
    if (typeof body.saved === "string") {
      const saved = readCard(me, body.saved);
      if (!saved) return c.json({ error: "Couldn't find that card" }, 404);
      card = saved.card;
      label = cardLabel(saved.meta);
    } else {
      const checked = checkCard(body.card ?? {});
      if ("error" in checked) return c.json({ error: checked.error }, 400);
      card = checked.card as CardDetails;
      label = cardLabel({ nickname: "", brand: cardBrand(card.number), last4: card.number.slice(-4), expires: card.expiry });
    }
    const record = approveCheckout(checkout.id, me, Number(body.revision), card, label);
    if (body.remember === true && typeof body.saved !== "string") saveCard(me, card, "");
    wakeCheckout(record.botId, record.threadId, record.id, true);
    return c.json({ record });
  });
  app.post("/shopping/:id/refresh", async c => {
    const record = shoppingRecord(c.req.param("id"), userId(c));
    if (record.kind !== "order") return c.json({ error: "Choose an order" }, 400);
    if (record.lastCheckedAt && Date.now() - Date.parse(record.lastCheckedAt) < 60_000) return c.json({ error: "Try again in a minute" }, 429);
    trackingChecked(record.id, userId(c), "active");
    // A user refresh follows the same durable queue as an automatic check.
    const { ensureDatabase } = await import("../db/init.ts");
    ensureDatabase().query("UPDATE gond_commerce SET next_check_at = ? WHERE id = ?").run(new Date().toISOString(), record.id);
    return c.json({ record: shoppingRecord(record.id, userId(c)) });
  });
  return app;
}
