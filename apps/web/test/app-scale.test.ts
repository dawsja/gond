import { expect, test } from "bun:test";
import { appScale } from "../lib/theme/theme";

const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";

test("the Android app is zoomed, whatever its version", () => {
  expect(appScale(`${android} Gond/0.2.80 (Android)`)).toBe(1.15);
  expect(appScale(`${android} Gond/0.1.0 (Android)`)).toBe(1.15);
});

test("an iPhone app is zoomed only once it draws its chrome at the page's scale", () => {
  expect(appScale(`${iphone} Mobile/15E148 Gond/0.2.91 (iOS)`)).toBe(1.15);
  expect(appScale(`${iphone} Mobile/15E148 Gond/0.3.0 (iOS)`)).toBe(1.15);
  expect(appScale(`${iphone} Mobile/15E148 Gond/1.0.0 (iOS)`)).toBe(1.15);
  expect(appScale(`${iphone} Mobile/15E148 Gond/0.2.90 (iOS)`)).toBe(1);
  expect(appScale(`${iphone} Mobile/15E148 Gond/0.1.0 (iOS)`)).toBe(1);
});

test("a browser and the desktop app aren't", () => {
  expect(appScale(android)).toBe(1);
  expect(appScale(`${iphone} Mobile/15E148 Safari/604.1`)).toBe(1);
  expect(appScale("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe(1);
  expect(appScale(null)).toBe(1);
});
