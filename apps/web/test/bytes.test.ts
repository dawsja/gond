import { expect, test } from "bun:test";
import { formatBytes } from "../lib/bytes";

const KB = 1024;
const MB = 1024 ** 2;

test("a size keeps one decimal under ten of its unit and none above", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(5.5 * KB)).toBe("5.5 KB");
  expect(formatBytes(15.3 * MB)).toBe("15 MB");
  expect(formatBytes(1 * MB)).toBe("1 MB");
  expect(formatBytes(9.96 * KB)).toBe("10 KB");
});

test("a size just under the next unit reads as that unit, never 1024 of this one", () => {
  expect(formatBytes(MB - 1)).toBe("1 MB");
  expect(formatBytes(1023 * KB)).toBe("1023 KB");
  expect(formatBytes(3 * 1024 * MB)).toBe("3 GB");
  expect(formatBytes(-5)).toBe("0 B");
});
