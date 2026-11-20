import { expect, test } from "bun:test";
import { CHECKOUT_STATES, type ShoppingCheckout, type ShoppingOrder, type ShoppingRecord } from "@gond/shared";
import { settled } from "../components/shopping-card";

const checkout = (state: ShoppingCheckout["state"]) => ({ kind: "checkout", state }) as ShoppingCheckout;
const order = (tracking: ShoppingOrder["tracking"]) => ({ kind: "order", tracking }) as ShoppingOrder;

test("a card stops reloading only once its record can't change", () => {
  expect(settled({ kind: "products" } as ShoppingRecord)).toBe(true);
  const open = CHECKOUT_STATES.filter((state) => !settled(checkout(state)));
  expect(open).toEqual(["preparing", "review", "approved", "submitting", "unknown"]);
  expect(settled(order("active"))).toBe(false);
  expect(settled(order("paused"))).toBe(false);
  expect(settled(order("complete"))).toBe(true);
});
