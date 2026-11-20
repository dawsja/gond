import type { z } from "zod";
import type { addressSchema, moneySchema, offerSchema, productSchema, quoteSchema, shipmentSchema } from "./shopping-schemas.ts";

/** Shopping links are public HTTPS resources, never local services or credential-bearing URLs. */
export function shoppingUrl(value: string): boolean {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && h.includes(".") && !h.includes(":") && !/^\d/.test(h) && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(h) && !h.endsWith(".local") && !h.endsWith(".internal");
  } catch { return false; }
}
export type Money = z.infer<typeof moneySchema>;
export function shoppingPrice(money: Money): string {
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency });
  return formatter.format(money.amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}
export type ShoppingProduct = z.infer<typeof productSchema>;
export type ShoppingOffer = z.infer<typeof offerSchema>;
export type ShippingAddress = z.infer<typeof addressSchema>;
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
export type ShoppingShipment = z.infer<typeof shipmentSchema>;
export type ShoppingOrder = {
  kind: "order"; id: string; checkoutId: string; threadId: string; botId: string;
  merchantOrderId: string; receiptUrl: string; evidence: string; payment: "unknown" | "pending" | "confirmed" | "failed";
  shipments: ShoppingShipment[]; tracking: "active" | "paused" | "complete"; lastCheckedAt: string | null; nextCheckAt: string | null;
  checkout: ShoppingCheckout; createdAt: string;
};
export type ShoppingRecord = ProductCollection | ShoppingCheckout | ShoppingOrder;
