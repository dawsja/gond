import { z } from "zod";
import { shoppingUrl } from "./shopping.ts";

export const shoppingLink = z.string().max(2048).refine(shoppingUrl, "Use a public HTTPS URL");
const text = z.string().trim().min(1).max(200);
export const moneySchema = z.object({ amount: z.number().int().nonnegative().max(100_000_000), currency: z.string().regex(/^[A-Z]{3}$/) });
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
export const addressSchema = z.object({ name: text, line1: text, line2: z.string().max(200).default(""), city: text, region: text, postalCode: text, country: z.string().regex(/^[A-Z]{2}$/), email: z.email().max(200), phone: z.string().max(40).default("") });
export const quoteSchema = z.object({
  url: shoppingLink, subtotal: moneySchema, shipping: moneySchema, tax: moneySchema, discount: moneySchema,
  total: moneySchema, delivery: z.string().max(200), submitLabel: text,
  evidence: z.string().min(1).max(12000),
});
export const shipmentSchema = z.object({
  id: text, carrier: text, trackingNumber: text, url: shoppingLink,
  stage: z.enum(["label_created", "shipped", "out_for_delivery", "delivered", "exception"]),
  estimatedArrival: z.string().max(200), eventAt: z.iso.datetime(), detail: text,
});
