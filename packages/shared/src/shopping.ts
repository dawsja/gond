import { z } from "zod";

/** Shopping links are public HTTPS resources, never local services or credential-bearing URLs. */
export function shoppingUrl(value: string): boolean {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && h.includes(".") && !h.includes(":") && !/^\d/.test(h) && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(h) && !h.endsWith(".local") && !h.endsWith(".internal");
  } catch { return false; }
}
export const shoppingLink = z.string().max(2048).refine(shoppingUrl, "Use a public HTTPS URL");
const text = z.string().trim().min(1).max(200);
export const moneySchema = z.object({ amount: z.number().int().nonnegative().max(100_000_000), currency: z.string().regex(/^[A-Z]{3}$/) });
export type Money = z.infer<typeof moneySchema>;
export function shoppingPrice(money: Money): string {
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency });
  return formatter.format(money.amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}
export const offerSchema = z.object({
  id: text, store: text, url: shoppingLink, price: moneySchema,
  availability: z.enum(["in_stock", "out_of_stock", "unknown"]),
  delivery: z.string().max(200).optional(), observedAt: z.iso.datetime(),
});
export const variantSchema = z.object({ id: text, options: z.record(z.string().max(40), z.string().max(80)), offers: z.array(offerSchema).min(1).max(10) });
export const productSchema = z.object({
  id: text, title: text, images: z.array(shoppingLink).max(8), variants: z.array(variantSchema).min(1).max(40),
  rating: z.object({ value: z.number().min(0).max(5), count: z.number().int().nonnegative(), source: shoppingLink }).optional(),
  badges: z.array(z.enum(["Top rated", "Lowest price"])).max(2).default([]),
});
export const productsSchema = z.object({ products: z.array(productSchema).min(1).max(12) });
export type ShoppingProduct = z.infer<typeof productSchema>;
export type ShoppingOffer = z.infer<typeof offerSchema>;
export const addressSchema = z.object({ name: text, line1: text, line2: z.string().max(200).default(""), city: text, region: text, postalCode: text, country: z.string().regex(/^[A-Z]{2}$/), email: z.email().max(200), phone: z.string().max(40).default("") });
export type ShippingAddress = z.infer<typeof addressSchema>;
export const quoteSchema = z.object({
  url: shoppingLink, subtotal: moneySchema, shipping: moneySchema, tax: moneySchema, discount: moneySchema,
  total: moneySchema, delivery: z.string().max(200), submitLabel: text,
  evidence: z.string().min(1).max(12000),
});
export type ShoppingQuote = z.infer<typeof quoteSchema>;
export const CHECKOUT_STATES = ["preparing", "review", "approved", "submitting", "unknown", "ordered", "cancelled", "expired", "failed"] as const;
export type CheckoutState = typeof CHECKOUT_STATES[number];
export type ProductCollection = { kind: "products"; id: string; threadId: string; botId: string; products: ShoppingProduct[]; createdAt: string };
export type ShoppingCheckout = {
  kind: "checkout"; id: string; threadId: string; botId: string; collectionId: string; product: ShoppingProduct;
  variantId: string; offer: ShoppingOffer; quantity: number; state: CheckoutState; revision: number;
  quote: ShoppingQuote | null; address: ShippingAddress | null; paymentLabel: string | null; expiresAt: string | null;
  createdAt: string; updatedAt: string;
};
export const shipmentSchema = z.object({
  id: text, carrier: text, trackingNumber: text, url: shoppingLink,
  stage: z.enum(["label_created", "shipped", "out_for_delivery", "delivered", "exception"]),
  estimatedArrival: z.string().max(200), eventAt: z.iso.datetime(), detail: text,
});
export type ShoppingShipment = z.infer<typeof shipmentSchema>;
export type ShoppingOrder = {
  kind: "order"; id: string; checkoutId: string; threadId: string; botId: string;
  merchantOrderId: string; receiptUrl: string; evidence: string; payment: "unknown" | "pending" | "confirmed" | "failed";
  shipments: ShoppingShipment[]; tracking: "active" | "paused" | "complete"; lastCheckedAt: string | null; nextCheckAt: string | null;
  checkout: ShoppingCheckout; createdAt: string;
};
export type ShoppingRecord = ProductCollection | ShoppingCheckout | ShoppingOrder;
