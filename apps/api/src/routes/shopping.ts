import { addressSchema, cardBrand, cardLabel, checkCard, checkCardCode, type CardDetails, type ShippingAddress } from "@gond/shared";
import { Hono, type Context } from "hono";
import { ownsThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { approveCheckout, cancelCheckout, checkOrderNow, checkoutRecord, setCheckoutAddress, shoppingRecord, startCheckout } from "../data/shopping.ts";
import { readCard, saveCard } from "../data/secrets.ts";
import { wakeCheckout } from "../shopping.ts";
import { readBody } from "./body.ts";

const ADDRESS_FIELDS: Record<keyof ShippingAddress, string> = {
  name: "the full name",
  line1: "the street address",
  line2: "the apartment or suite",
  city: "the city",
  region: "the state or region",
  postalCode: "the ZIP or postal code",
  country: "the country, as two letters like US",
  email: "the email address",
  phone: "the phone number",
};

/** The shipping address, or what to fix in it, in words the person can act on. */
function addressOf(input: unknown): ShippingAddress | string {
  const parsed = addressSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  return `Check ${typeof field === "string" && field in ADDRESS_FIELDS ? ADDRESS_FIELDS[field as keyof ShippingAddress] : "the address"}`;
}

// The data layer's refusals are written for the person ("This checkout changed. Refresh it first"); a
// missing record is a 404, as everywhere else.
function failed(c: Context<Env>, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^Couldn't find/.test(message)) return c.json({ error: message }, 404);
  return c.json({ error: message || "That didn't work. Try again" }, 400);
}

export function shoppingRoutes() {
  const app = new Hono<Env>();
  app.onError((error, c) => failed(c, error));

  app.get("/shopping/:id", (c) => c.json({ record: shoppingRecord(c.req.param("id"), userId(c)) }));

  app.post("/shopping/:id/checkout", async (c) => {
    const body = await readBody(c);
    if (typeof body.actionKey !== "string" || !body.actionKey || body.actionKey.length > 100) return c.json({ error: "Open the product again, then tap Buy now" }, 400);
    if (typeof body.productId !== "string" || typeof body.variantId !== "string" || typeof body.offerId !== "string") return c.json({ error: "Pick an option and a store first" }, 400);
    const record = startCheckout(userId(c), c.req.param("id"), { productId: body.productId, variantId: body.variantId, offerId: body.offerId, quantity: Number(body.quantity), actionKey: body.actionKey });
    return c.json({ record });
  });

  app.post("/shopping/:id/address", async (c) => {
    const body = await readBody(c);
    const address = addressOf(body.address);
    if (typeof address === "string") return c.json({ error: address }, 400);
    const record = setCheckoutAddress(c.req.param("id"), userId(c), Number(body.revision), address);
    wakeCheckout(record.botId, record.threadId, record.id);
    return c.json({ record });
  });

  app.post("/shopping/:id/cancel", async (c) => {
    const body = await readBody(c);
    return c.json({ record: cancelCheckout(c.req.param("id"), userId(c), Number(body.revision)) });
  });

  app.post("/shopping/:id/approve", async (c) => {
    const body = await readBody(c);
    const me = userId(c);
    const checkout = checkoutRecord(c.req.param("id"), me);
    if (!ownsThread(c, checkout.threadId)) return c.json({ error: "Couldn't find that checkout" }, 404);
    let card: CardDetails;
    let label: string;
    if (typeof body.saved === "string") {
      const saved = readCard(me, body.saved);
      if (!saved) return c.json({ error: "Couldn't find that card" }, 404);
      // A saved card never keeps its security code; it is typed for each payment and held only with this approval.
      const code = checkCardCode(body.cvc);
      if ("error" in code) return c.json({ error: code.error }, 400);
      card = { ...saved.card, cvc: code.cvc };
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

  app.post("/shopping/:id/refresh", (c) => {
    try {
      return c.json({ record: checkOrderNow(c.req.param("id"), userId(c)) });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("It was checked")) return c.json({ error: error.message }, 429);
      throw error;
    }
  });

  return app;
}
