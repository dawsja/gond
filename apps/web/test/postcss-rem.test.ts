import { expect, test } from "bun:test";
import plugin, { toRem } from "../postcss-rem.mjs";

test("pixel sizes become rem at 16px to the rem", () => {
  expect(toRem("14px")).toBe("0.875rem");
  expect(toRem("22px")).toBe("1.375rem");
  expect(toRem("12.5px")).toBe("0.78125rem");
  expect(toRem("-7px")).toBe("-0.4375rem");
  expect(toRem("0 16px 40px rgba(20, 16, 8, 0.16)")).toBe("0 1rem 2.5rem rgba(20, 16, 8, 0.16)");
});

test("sizes inside calc, max and min convert", () => {
  expect(toRem("calc(64px + var(--safe-top))")).toBe("calc(4rem + var(--safe-top))");
  expect(toRem("max(12px, var(--safe-bottom))")).toBe("max(0.75rem, var(--safe-bottom))");
  expect(toRem("min(var(--radius-md), 10px)")).toBe("min(var(--radius-md), 0.625rem)");
});

test("hairlines, zero, urls and strings stay as written", () => {
  expect(toRem("1px solid var(--border)")).toBe("1px solid var(--border)");
  expect(toRem("1.5px")).toBe("1.5px");
  expect(toRem("0px")).toBe("0px");
  expect(toRem('url("/grid-48px.png")')).toBe('url("/grid-48px.png")');
  expect(toRem("url(/a-16px.svg) 16px")).toBe("url(/a-16px.svg) 1rem");
  expect(toRem('"24px"')).toBe('"24px"');
  expect(toRem("2rem 50%")).toBe("2rem 50%");
});

test("an endless radius and digits inside names aren't sizes", () => {
  expect(toRem("3.40282e38px")).toBe("3.40282e38px");
  expect(toRem("calc(infinity * 1px)")).toBe("calc(infinity * 1px)");
  expect(toRem("var(--gap-12px) 12px")).toBe("var(--gap-12px) 0.75rem");
  expect(toRem("calc(100% - 2px)")).toBe("calc(100% - 0.125rem)");
  expect(toRem(".5px 8.px")).toBe(".5px 0.5rem");
});

test("the plugin rewrites declarations, custom properties included", () => {
  const declaration = { prop: "--radius-3xl", value: "24px" };
  plugin().Declaration(declaration);
  expect(declaration.value).toBe("1.5rem");
});
