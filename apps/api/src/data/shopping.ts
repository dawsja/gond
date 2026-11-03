import { addressSchema, productsSchema, quoteSchema, shipmentSchema, shoppingPrice, shoppingUrl, type ProductCollection, type ShoppingCheckout, type ShoppingOrder, type ShoppingRecord, type ShoppingQuote, type CardDetails } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { newId, now } from "../ids.ts";
import { encryptSecret, decryptSecret } from "../secrets.ts";
import { threadChanged } from "../events.ts";
import { getThread, postMessage } from "./threads.ts";
import { spaceOfThread } from "./spaces.ts";

type Row = { id: string; user_id: string; thread_id: string; bot_id: string; kind: ShoppingRecord["kind"]; state: string; revision: number; payload: string; private: string | null; next_check_at: string | null; lease_until: string | null; created_at: string; updated_at: string };
const cards = new Map<string, { card: CardDetails; until: number }>();
/** Refuse ambiguous totals, including when the old approved amount appears only as the subtotal. */
export function liveTotalMatches(text: string, total: ShoppingQuote["total"]): boolean {
  const decimals = new Intl.NumberFormat("en-US", { style: "currency", currency: total.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const values = [...text.matchAll(/\btotal\b\s*[^\d\n]{0,30}\s*(\d[\d,]*(?:\.\d{1,3})?)/gi)].map(m => Math.round(Number(m[1]!.replaceAll(",", "")) * 10 ** decimals));
  return values.length > 0 && values.every(v => v === total.amount);
}
export function liveItemsMatch(text: string, checkout: ShoppingCheckout): boolean {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const includes = (value: string) => normalized.includes(value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  const variant = checkout.product.variants.find(v => v.id === checkout.variantId);
  const quantities = [...text.matchAll(/\b(?:qty|quantity)\s*[:"=]?\s*(\d+)\b/gi)].map(m => Number(m[1]));
  return includes(checkout.product.title) && Boolean(variant && Object.values(variant.options).every(includes))
    && quantities.length > 0 && quantities.every(q => q === checkout.quantity)
    && Boolean(checkout.address && includes(checkout.address.line1) && includes(checkout.address.postalCode));
}
export function shoppingRow(id: string, userId: string): Row {
  const row = ensureDatabase().query("SELECT * FROM gond_commerce WHERE id = ? AND user_id = ?").get(id, userId) as Row | null;
  if (!row) throw new Error("Couldn't find that shopping card");
  return row;
}
export function shoppingRecord(id: string, userId: string): ShoppingRecord {
  const row = shoppingRow(id, userId);
  const value = JSON.parse(decryptSecret(row.payload));
  if (row.kind === "checkout") return { ...value, state: row.state, revision: row.revision, address: row.private ? JSON.parse(decryptSecret(row.private)) : null, updatedAt: row.updated_at };
  if (row.kind === "order") return { ...value, tracking: row.state, nextCheckAt: row.next_check_at, checkout: shoppingRecord(value.checkoutId, userId) };
  return value;
}
function insert(userId: string, record: ShoppingRecord, state: string, parent: string | null = null, actionKey: string | null = null) {
  ensureDatabase().query("INSERT INTO gond_commerce(id,user_id,thread_id,bot_id,kind,state,payload,parent_id,action_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(record.id, userId, record.threadId, record.botId, record.kind, state, encryptSecret(JSON.stringify(record)), parent, actionKey, now(), now());
}
function save(row: Row, value: ShoppingRecord, state = row.state) {
  ensureDatabase().query("UPDATE gond_commerce SET payload = ?, state = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
    .run(encryptSecret(JSON.stringify(value.kind === "checkout" ? { ...value, address: null } : value.kind === "order" ? { ...value, checkout: { ...value.checkout, address: null } } : value)), state, now(), row.id);
  threadChanged(row.thread_id);
}
function privateThread(threadId: string, userId: string) {
  if (getThread(threadId)?.userId !== userId || spaceOfThread(threadId)) throw new Error("Shopping is available only in your private conversations");
}
export function presentProducts(userId: string, botId: string, threadId: string, input: unknown): ProductCollection {
  privateThread(threadId, userId);
  const { products } = productsSchema.parse(input);
  if (new Set(products.map(p => p.id)).size !== products.length) throw new Error("Product IDs must be unique");
  for (const p of products) {
    if (new Set(p.variants.map(v => v.id)).size !== p.variants.length) throw new Error("Variant IDs must be unique");
    for (const v of p.variants) if (new Set(v.offers.map(o => o.id)).size !== v.offers.length) throw new Error("Offer IDs must be unique");
  }
  const record: ProductCollection = { kind: "products", id: newId("shop"), botId, threadId, products, createdAt: now() };
  insert(userId, record, "ready");
  postMessage({ threadId, author: botId, commerceId: record.id, body: `Shopping: ${products.map(p => p.title).join(", ")}`, answered: true });
  return record;
}
export function startCheckout(userId: string, collectionId: string, input: { productId: string; variantId: string; offerId: string; quantity: number; actionKey: string }): ShoppingCheckout {
  return transaction(db => {
    const collection = shoppingRecord(collectionId, userId);
    if (collection.kind !== "products") throw new Error("Choose a product collection");
    privateThread(collection.threadId, userId);
    const previous = db.query("SELECT id FROM gond_commerce WHERE action_key = ? AND user_id = ?").get(`${userId}:${input.actionKey}`, userId) as { id: string } | null;
    if (previous) return shoppingRecord(previous.id, userId) as ShoppingCheckout;
    const product = collection.products.find(p => p.id === input.productId);
    const variant = product?.variants.find(v => v.id === input.variantId);
    const offer = variant?.offers.find(o => o.id === input.offerId);
    if (!product || !offer || offer.availability === "out_of_stock") throw new Error("That option is unavailable");
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) throw new Error("Choose a quantity from 1 to 20");
    if (activeCheckout(collection.botId, userId)) throw new Error("Finish or cancel the existing checkout first");
    const record: ShoppingCheckout = { kind: "checkout", id: newId("checkout"), threadId: collection.threadId, botId: collection.botId, collectionId, product, variantId: input.variantId, offer, quantity: input.quantity, state: "preparing", revision: 1, quote: null, address: null, paymentLabel: null, expiresAt: null, createdAt: now(), updatedAt: now() };
    insert(userId, record, record.state, collectionId, `${userId}:${input.actionKey}`);
    postMessage({ threadId: record.threadId, author: record.botId, commerceId: record.id, body: `Checkout: ${product.title} (${record.quantity})`, answered: true });
    return record;
  });
}
export function activeCheckout(botId: string, userId: string): ShoppingCheckout | null {
  const row = ensureDatabase().query("SELECT id FROM gond_commerce WHERE bot_id = ? AND user_id = ? AND kind = 'checkout' AND state IN ('preparing','review','approved','submitting','unknown')").get(botId, userId) as { id: string } | null;
  if (!row) return null;
  const checkout = shoppingRecord(row.id, userId) as ShoppingCheckout;
  if (["review", "approved"].includes(checkout.state) && checkout.expiresAt && checkout.expiresAt <= now()) {
    cancelCheckout(row.id, userId, checkout.revision, "expired");
    return null;
  }
  return checkout;
}
export function checkoutRecord(id: string, userId: string): ShoppingCheckout {
  const record = shoppingRecord(id, userId);
  if (record.kind !== "checkout") throw new Error("Choose a checkout");
  return record;
}
export function setCheckoutAddress(id: string, userId: string, revision: number, input: unknown) {
  const address = addressSchema.parse(input);
  return transaction(db => {
    const checkout = checkoutRecord(id, userId);
    if (checkout.revision !== revision || !["preparing", "review", "approved"].includes(checkout.state)) throw new Error("This checkout changed. Refresh it first");
    cards.delete(id);
    db.query("UPDATE gond_commerce SET private = ?, state = 'preparing', revision = revision + 1, updated_at = ? WHERE id = ?").run(encryptSecret(JSON.stringify(address)), now(), id);
    threadChanged(checkout.threadId);
    return checkoutRecord(id, userId);
  });
}
export function prepareCheckout(id: string, userId: string, input: unknown): ShoppingCheckout {
  const quote = quoteSchema.parse(input);
  return transaction(() => {
    const row = shoppingRow(id, userId), checkout = checkoutRecord(id, userId);
    if (!["preparing", "review", "approved"].includes(checkout.state) || !checkout.address) throw new Error("Add the shipping address before preparing the final quote");
    const lines = [quote.subtotal, quote.shipping, quote.tax, quote.discount, quote.total];
    if (!lines.every(m => m.currency === checkout.offer.price.currency) || quote.total.amount !== quote.subtotal.amount + quote.shipping.amount + quote.tax.amount - quote.discount.amount) throw new Error("The quote's currency or total does not match its line items");
    if (new URL(quote.url).origin !== new URL(checkout.offer.url).origin) throw new Error("A different checkout origin requires a separate verified merchant integration; use handoff for this store");
    cards.delete(id);
    save(row, { ...checkout, address: null, quote, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }, "review");
    return checkoutRecord(id, userId);
  });
}
export function approveCheckout(id: string, userId: string, revision: number, card: CardDetails, label: string): ShoppingCheckout {
  return transaction(() => {
    const row = shoppingRow(id, userId), checkout = checkoutRecord(id, userId);
    if (checkout.revision !== revision || checkout.state !== "review" || !checkout.quote || !checkout.expiresAt || checkout.expiresAt <= now()) throw new Error("This quote changed or expired. Review it again before paying");
    cards.set(id, { card, until: Date.now() + 10 * 60_000 });
    save(row, { ...checkout, paymentLabel: label }, "approved");
    return checkoutRecord(id, userId);
  });
}
export function cancelCheckout(id: string, userId: string, revision: number, state: "cancelled" | "expired" = "cancelled") {
  return transaction(() => {
    const row = shoppingRow(id, userId), checkout = checkoutRecord(id, userId);
    if (checkout.revision !== revision || !["preparing", "review", "approved"].includes(checkout.state)) throw new Error("This checkout can no longer be cancelled here");
    cards.delete(id); save(row, checkout, state);
    return checkoutRecord(id, userId);
  });
}
export function approvedCard(checkout: ShoppingCheckout): CardDetails | null {
  const held = cards.get(checkout.id);
  if (checkout.state !== "approved" || !held || held.until <= Date.now()) return null;
  return held.card;
}
export function shoppingCardValues(): string[] {
  for (const [id, held] of cards) if (held.until <= Date.now()) cards.delete(id);
  return [...cards.values()].flatMap(c => Object.values(c.card));
}
export function claimSubmission(id: string, userId: string, revision: number): ShoppingCheckout {
  return transaction(db => {
    const checkout = checkoutRecord(id, userId);
    if (checkout.revision !== revision || !approvedCard(checkout) || !checkout.expiresAt || checkout.expiresAt <= now()) throw new Error("Payment approval changed or expired");
    const changed = db.query("UPDATE gond_commerce SET state = 'submitting', revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'approved' AND revision = ?").run(now(), id, revision).changes;
    if (!changed) throw new Error("This checkout was already submitted");
    threadChanged(checkout.threadId);
    return checkoutRecord(id, userId);
  });
}
export function unknownSubmission(id: string, userId: string) {
  const row = shoppingRow(id, userId);
  if (row.state === "submitting") save(row, checkoutRecord(id, userId), "unknown");
}
export function resolveFailedCheckout(id: string, userId: string, evidence: string) {
  return transaction(db => {
    const row = shoppingRow(id, userId), checkout = checkoutRecord(id, userId);
    if (checkout.state !== "unknown" || !evidence.trim() || evidence.length > 12000) throw new Error("Resolve only an unknown submission with verified merchant failure evidence");
    db.query("INSERT INTO gond_commerce_events(id,record_id,event_key,body,created_at) VALUES(?,?,?,?,?)").run(newId("failure"), id, "confirmed-failure", encryptSecret(evidence), now());
    save(row, checkout, "failed");
    return checkoutRecord(id, userId);
  });
}
export function recordOrder(id: string, userId: string, input: { merchantOrderId: string; receiptUrl: string; evidence: string; payment: ShoppingOrder["payment"] }): ShoppingOrder {
  if (!input.merchantOrderId.trim() || input.merchantOrderId.length > 200 || !shoppingUrl(input.receiptUrl) || !input.evidence.includes(input.merchantOrderId)) throw new Error("Include the merchant's order reference and confirmation evidence");
  return transaction(db => {
    const existing = db.query("SELECT id FROM gond_commerce WHERE parent_id = ? AND kind = 'order'").get(id) as { id: string } | null;
    if (existing) return shoppingRecord(existing.id, userId) as ShoppingOrder;
    const row = shoppingRow(id, userId), checkout = checkoutRecord(id, userId);
    if (!["submitting", "unknown"].includes(checkout.state)) throw new Error("Only a submitted checkout can become an order");
    if (new URL(input.receiptUrl).origin !== new URL(checkout.offer.url).origin) throw new Error("Confirm the order on the selected merchant's site");
    save(row, checkout, "ordered");
    const order: ShoppingOrder = { kind: "order", id: newId("order"), checkoutId: id, botId: checkout.botId, threadId: checkout.threadId, ...input, shipments: [], tracking: "active", lastCheckedAt: now(), nextCheckAt: new Date(Date.now() + 6 * 3600_000).toISOString(), checkout: { ...checkout, address: null, state: "ordered" }, createdAt: now() };
    insert(userId, order, "active", id);
    db.query("UPDATE gond_commerce SET next_check_at = ? WHERE id = ?").run(order.nextCheckAt, order.id);
    postMessage({ threadId: checkout.threadId, author: checkout.botId, commerceId: order.id, body: `Order placed: ${checkout.product.title}. ${input.merchantOrderId}. Total ${shoppingPrice(checkout.quote!.total)}.`, answered: true });
    return shoppingRecord(order.id, userId) as ShoppingOrder;
  });
}
export function recordShipment(id: string, userId: string, input: unknown): { order: ShoppingOrder; changed: boolean } {
  const shipment = shipmentSchema.parse(input);
  return transaction(db => {
    const row = shoppingRow(id, userId), order = shoppingRecord(id, userId);
    if (order.kind !== "order") throw new Error("Choose an order");
    const old = order.shipments.find(s => s.id === shipment.id);
    if (old && old.eventAt >= shipment.eventAt) return { order, changed: false };
    const key = `${shipment.id}:${shipment.stage}:${shipment.eventAt}`;
    const added = db.query("INSERT OR IGNORE INTO gond_commerce_events(id,record_id,event_key,body,created_at) VALUES(?,?,?,?,?)").run(newId("shipment"), id, key, encryptSecret(JSON.stringify(shipment)), now()).changes;
    if (!added) return { order, changed: false };
    order.shipments = [...order.shipments.filter(s => s.id !== shipment.id), shipment];
    order.lastCheckedAt = now();
    save(row, order);
    return { order: shoppingRecord(id, userId) as ShoppingOrder, changed: !old || old.stage !== shipment.stage };
  });
}
export function trackingChecked(id: string, userId: string, state: "active" | "paused" | "complete") {
  const row = shoppingRow(id, userId), order = shoppingRecord(id, userId);
  if (order.kind !== "order") throw new Error("Choose an order");
  const next = state === "active" ? new Date(Date.now() + (order.shipments.length ? 2 : 6) * 3600_000).toISOString() : null;
  ensureDatabase().query("UPDATE gond_commerce SET next_check_at = ?, lease_until = NULL WHERE id = ?").run(next, id);
  save(row, { ...order, lastCheckedAt: now(), nextCheckAt: next, tracking: state }, state);
}
export function claimTracking(at = now()): Row[] {
  return transaction(db => {
    const rows = db.query("SELECT * FROM gond_commerce WHERE kind = 'order' AND state = 'active' AND next_check_at <= ? AND (lease_until IS NULL OR lease_until <= ?) LIMIT 5").all(at, at) as Row[];
    for (const row of rows) db.query("UPDATE gond_commerce SET lease_until = ?, next_check_at = ? WHERE id = ?").run(new Date(Date.parse(at) + 30 * 60_000).toISOString(), new Date(Date.parse(at) + 6 * 3600_000).toISOString(), row.id);
    return rows;
  });
}
export function listShopping(userId: string, threadId: string): ShoppingRecord[] {
  return (ensureDatabase().query("SELECT id FROM gond_commerce WHERE user_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 50").all(userId, threadId) as { id: string }[]).map(r => shoppingRecord(r.id, userId));
}
