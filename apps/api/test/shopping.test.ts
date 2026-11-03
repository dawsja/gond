import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { botInputSchema, shoppingPrice, shoppingUrl, type CardDetails } from "@gond/shared";
import { createBot } from "../src/data/bots.ts";
import { getThread, listMessages } from "../src/data/threads.ts";
import { ensureDatabase, resetDbReady } from "../src/db/init.ts";
import { closeDb } from "../src/db/sqlite.ts";
import { activeCheckout, approveCheckout, approvedCard, cancelCheckout, checkoutRecord, claimSubmission, claimTracking, liveTotalMatches, prepareCheckout, presentProducts, recordOrder, recordShipment, resolveFailedCheckout, setCheckoutAddress, shoppingRecord, startCheckout, trackingChecked, unknownSubmission } from "../src/data/shopping.ts";
import { computerTool } from "../src/computer-tool.ts";
import { readCard, saveCard } from "../src/data/secrets.ts";
import { shoppingRoutes } from "../src/routes/shopping.ts";
import type { Env } from "../src/app.ts";

let previous: string | undefined, directory: string;
beforeAll(() => { previous = process.env.GOND_DATA_DIR; directory = mkdtempSync(join(tmpdir(), "gond-shopping-")); process.env.GOND_DATA_DIR = directory; resetDbReady(); });
afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.GOND_DATA_DIR; else process.env.GOND_DATA_DIR = previous; resetDbReady(); });
const price = (amount: number) => ({ amount, currency: "USD" });
const address = { name: "Jane Appleseed", line1: "1 Market St", line2: "", city: "San Francisco", region: "CA", postalCode: "94105", country: "US", email: "jane@example.com", phone: "" };
const card: CardDetails = { number: "4242424242424242", expiry: "08/29", cvc: "123", name: "Jane", zip: "94105" };
const quote = { url: "https://kettle.example/checkout", subtotal: price(6499), shipping: price(0), tax: price(569), discount: price(0), total: price(7068), delivery: "Thu, Nov 5", submitLabel: "Place order", evidence: "Matte black kettle. Black 0.9 L. Qty 1. Subtotal $64.99. Shipping $0.00. Tax $5.69. Total $70.68" };
function setup() {
  const bot = createBot(botInputSchema.parse({ name: "Patch", approval: "full" }), "shopping-owner");
  const collection = presentProducts("shopping-owner", bot.id, bot.threadId, { products: [{ id: "kettle", title: "Matte black kettle", images: [], variants: [{ id: "black", options: { color: "Black", capacity: "0.9 L" }, offers: [{ id: "kc", store: "Kettle & Co", url: "https://kettle.example/product", price: price(6499), availability: "in_stock", observedAt: new Date().toISOString() }] }, { id: "small", options: { capacity: "0.6 L" }, offers: [{ id: "kc", store: "Kettle & Co", url: "https://kettle.example/product", price: price(4900), availability: "out_of_stock", observedAt: new Date().toISOString() }] }] }] });
  const input = { productId: "kettle", variantId: "black", offerId: "kc", quantity: 1, actionKey: crypto.randomUUID() };
  const checkout = startCheckout("shopping-owner", collection.id, input);
  return { bot, collection, checkout, input };
}
function review() { const ctx = setup(); setCheckoutAddress(ctx.checkout.id, "shopping-owner", 1, address); const checkout = prepareCheckout(ctx.checkout.id, "shopping-owner", quote); return { ...ctx, checkout }; }

describe("shopping purchase lifecycle", () => {
  test("preparation cannot click a purchase button or submit through the desktop", async () => {
    const { bot } = setup();
    const tools = computerTool({ bot, thread: getThread(bot.threadId)!, box: { url: "http://127.0.0.1:1", token: "unused", user: bot.userId } });
    expect(String(await tools.browser.execute({ actions: [{ type: "click", label: "Place order" }] }, "preparing"))).toContain("Do not submit");
    expect(String(await tools.computer.execute({ actions: [{ type: "click", x: 1, y: 1 }] }, "desktop"))).toContain("structured browser");
  });
  test("requires the actual final total, not an old amount still present elsewhere on the page", () => {
    expect(liveTotalMatches("Subtotal $70.68\nTotal $78.00", price(7068))).toBe(false);
    expect(liveTotalMatches("Total\n$70.68", price(7068))).toBe(true);
    expect(liveTotalMatches("Order total: USD 70.68", price(7068))).toBe(true);
    expect(liveTotalMatches("Total $70.68\nTotal $80.00", price(7068))).toBe(false);
  });
  test("browser tools enforce approval, origin binding, private entry and one submission", async () => {
    let { checkout, bot } = review();
    let currentUrl = quote.url, total = "$70.68", clicks = 0;
    let entered = "";
    const server = Bun.serve({ port: 0, async fetch(request) {
      const body = await request.json() as { steps: { type: string; text?: string }[] };
      for (const step of body.steps) { if (step.type === "click") clicks++; if (step.type === "fill") entered = step.text ?? ""; }
      return Response.json({ ok: true, target: "browser", control: "bots", screen: { width: 1024, height: 640 }, done: [], error: null, url: currentUrl, outputs: [{ index: 0, text: `Matte black kettle\nBlack · 0.9 L\nQty 1\n1 Market St, 94105\nSubtotal $64.99\nTax $5.69\nTotal ${total}\n${entered}` }], image: "cHJpdmF0ZQ==", mime: "image/png" });
    } });
    try {
      const tools = computerTool({ bot, thread: getThread(bot.threadId)!, box: { url: server.url.origin, token: "fixture", user: bot.userId } });
      expect(String(await tools.browser.execute({ actions: [{ type: "click", label: "Place order" }] }, "before"))).toContain("locked");
      checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa");
      currentUrl = "https://other.example/checkout";
      expect(String(await tools.browser.execute({ actions: [{ type: "type_login", ref: "card", name: "CARD_NUMBER" }] }, "wrong"))).toContain("changed");
      expect(entered).toBe(""); currentUrl = quote.url;
      const result = await tools.browser.execute({ actions: [{ type: "type_login", ref: "card", name: "CARD_NUMBER" }] }, "fill");
      expect(entered).toBe(card.number); expect(String(result)).not.toContain(card.number); expect(typeof result).toBe("string");
      const code = await tools.browser.execute({ actions: [{ type: "type_login", ref: "code", name: "CARD_CVC" }] }, "code");
      expect(entered).toBe("123"); expect(String(code)).not.toContain("123");
      total = "$80.00";
      expect(String(await tools.submit_checkout.execute({ checkoutId: checkout.id, revision: checkout.revision }, "changed"))).toContain("no longer matches");
      expect(clicks).toBe(0); total = "$70.68";
      await tools.submit_checkout.execute({ checkoutId: checkout.id, revision: checkout.revision }, "submit");
      expect(clicks).toBe(1);
      await tools.submit_checkout.execute({ checkoutId: checkout.id, revision: checkout.revision }, "again");
      expect(clicks).toBe(1);
    } finally { server.stop(true); }
  });
  test("persists selections, deduplicates clicks, isolates owners and disables sold-out variants", () => {
    const { collection, checkout, input, bot } = setup();
    expect(startCheckout("shopping-owner", collection.id, input).id).toBe(checkout.id);
    expect(() => shoppingRecord(collection.id, "another-owner")).toThrow();
    expect(() => startCheckout("shopping-owner", collection.id, { ...input, actionKey: crypto.randomUUID(), variantId: "small" })).toThrow("unavailable");
    expect(listMessages(bot.threadId).some(m => m.commerceId === collection.id)).toBe(true);
    expect(() => claimSubmission(checkout.id, "shopping-owner", checkout.revision)).toThrow();
    cancelCheckout(checkout.id, "shopping-owner", checkout.revision);
  });
  test("encrypts addresses and invalidates approval whenever a quote or address changes", () => {
    let { checkout } = review();
    const stored = ensureDatabase().query("SELECT private, payload FROM gond_commerce WHERE id = ?").get(checkout.id) as { private: string; payload: string };
    expect(stored.private).not.toContain("Market"); expect(stored.payload).not.toContain("kettle");
    expect(checkout.address?.postalCode).toBe("94105");
    expect(() => prepareCheckout(checkout.id, "shopping-owner", { ...quote, total: price(1) })).toThrow("total");
    expect(() => prepareCheckout(checkout.id, "shopping-owner", { ...quote, url: "https://other.example/checkout" })).toThrow("origin");
    checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa 4242");
    expect(approvedCard(checkout)?.cvc).toBe("123");
    const oldRevision = checkout.revision;
    checkout = setCheckoutAddress(checkout.id, "shopping-owner", oldRevision, { ...address, line1: "2 Market St" });
    expect(checkout.state).toBe("preparing"); expect(approvedCard(checkout)).toBeNull();
    expect(() => approveCheckout(checkout.id, "shopping-owner", oldRevision, card, "Visa")).toThrow();
  });
  test("submits once, reconciles unknown outcomes, and keeps order confirmation separate from payment", () => {
    let { checkout } = review();
    checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa 4242");
    const claimed = claimSubmission(checkout.id, "shopping-owner", checkout.revision);
    expect(claimed.state).toBe("submitting");
    expect(() => claimSubmission(checkout.id, "shopping-owner", checkout.revision)).toThrow();
    unknownSubmission(checkout.id, "shopping-owner");
    expect(checkoutRecord(checkout.id, "shopping-owner").state).toBe("unknown");
    expect(() => cancelCheckout(checkout.id, "shopping-owner", claimed.revision)).toThrow();
    const input = { merchantOrderId: "KC-20481", receiptUrl: "https://kettle.example/orders/KC-20481", evidence: "Order confirmed KC-20481", payment: "unknown" as const };
    const order = recordOrder(checkout.id, "shopping-owner", input);
    expect(order.payment).toBe("unknown"); expect(order.checkout.address?.name).toBe("Jane Appleseed");
    expect(recordOrder(checkout.id, "shopping-owner", input).id).toBe(order.id);
  });
  test("deduplicates shipment events, rejects older events, retains split packages, and leases checks", () => {
    let { checkout } = review(); checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa"); claimSubmission(checkout.id, "shopping-owner", checkout.revision);
    const order = recordOrder(checkout.id, "shopping-owner", { merchantOrderId: "KC-2", receiptUrl: "https://kettle.example/orders/2", evidence: "KC-2 confirmed", payment: "pending" });
    const shipment = { id: "package1", carrier: "Parcelway", trackingNumber: "PW2", url: "https://parcel.example/2", stage: "shipped", estimatedArrival: "Thursday", eventAt: "2026-11-03T10:24:00Z", detail: "Received by carrier" };
    expect(recordShipment(order.id, "shopping-owner", shipment).changed).toBe(true);
    expect(recordShipment(order.id, "shopping-owner", shipment).changed).toBe(false);
    expect(recordShipment(order.id, "shopping-owner", { ...shipment, eventAt: "2026-11-02T10:24:00Z", stage: "label_created" }).changed).toBe(false);
    expect(recordShipment(order.id, "shopping-owner", { ...shipment, id: "package2" }).order.shipments).toHaveLength(2);
    const future = new Date(Date.now() + 7 * 3600_000).toISOString();
    expect(claimTracking(future).filter(r => r.id === order.id)).toHaveLength(1);
    expect(claimTracking(future).filter(r => r.id === order.id)).toHaveLength(0);
    trackingChecked(order.id, "shopping-owner", "paused");
    expect(claimTracking(future).filter(r => r.id === order.id)).toHaveLength(0);
  });
  test("restart expires approvals and preserves unknown submissions without a second purchase", () => {
    let { checkout, bot } = review(); checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa"); claimSubmission(checkout.id, "shopping-owner", checkout.revision);
    resetDbReady(); ensureDatabase();
    expect(activeCheckout(bot.id, "shopping-owner")?.state).toBe("unknown");
    expect(() => claimSubmission(checkout.id, "shopping-owner", checkout.revision)).toThrow();
  });
  test("never saves a security code, including when updating a saved card", () => {
    const name = saveCard("shopping-owner", card, "Personal");
    expect(readCard("shopping-owner", name)?.card.cvc).toBe("");
    saveCard("shopping-owner", { ...card, cvc: "999" }, "Personal", name);
    expect(readCard("shopping-owner", name)?.card.cvc).toBe("");
  });
  test("a confirmed merchant failure releases the checkout without retrying its payment", () => {
    let { checkout, collection, input } = review();
    checkout = approveCheckout(checkout.id, "shopping-owner", checkout.revision, card, "Visa");
    claimSubmission(checkout.id, "shopping-owner", checkout.revision); unknownSubmission(checkout.id, "shopping-owner");
    expect(() => resolveFailedCheckout(checkout.id, "shopping-owner", "")).toThrow();
    expect(resolveFailedCheckout(checkout.id, "shopping-owner", "Merchant explicitly confirms the payment was declined and no order was created").state).toBe("failed");
    expect(() => claimSubmission(checkout.id, "shopping-owner", checkout.revision)).toThrow();
    const fresh = startCheckout("shopping-owner", collection.id, { ...input, actionKey: crypto.randomUUID() });
    expect(fresh.state).toBe("preparing"); expect(fresh.quote).toBeNull();
  });
  test("validates public URLs and currency-specific minor units", () => {
    for (const url of ["http://shop.example", "https://127.0.0.1", "https://localhost", "https://10.0.0.1", "https://[::1]", "https://u:p@shop.example", "https://shop.internal"]) expect(shoppingUrl(url)).toBe(false);
    expect(shoppingPrice({ amount: 100, currency: "JPY" })).toBe("¥100");
    expect(shoppingPrice(price(7068))).toBe("$70.68");
  });
  test("routes reject another owner's cards and stale approval submissions", async () => {
    const { checkout } = review();
    function app(user: string) { const app = new Hono<Env>(); app.use("*", async (c, next) => { c.set("session", { user: { id: user } } as Env["Variables"]["session"]); await next(); }); app.route("/api", shoppingRoutes()); return app; }
    expect((await app("someone-else").request(`/api/shopping/${checkout.id}`)).status).toBe(404);
    const response = await app("shopping-owner").request(`/api/shopping/${checkout.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, card }) });
    expect(response.status).toBe(400);
    expect(checkoutRecord(checkout.id, "shopping-owner").state).toBe("review");
  });
});
