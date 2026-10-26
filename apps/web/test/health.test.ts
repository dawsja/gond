import { expect, test } from "bun:test";
import { checkedAgo, diskLow, formatBytes, percentOf } from "../lib/health";

const GB = 1024 ** 3;

test("sizes read in the unit a person expects", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(200 * 1024 ** 2)).toBe("200 MB");
  expect(formatBytes(1.94 * GB)).toBe("1.9 GB");
  expect(formatBytes(41.3 * GB)).toBe("41 GB");
  expect(formatBytes(2.5 * 1024 * GB)).toBe("2.5 TB");
  expect(formatBytes(Number.NaN)).toBe("0 B");
});

test("a check's time reads as words", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  expect(checkedAgo("2026-10-26T11:59:40Z", now)).toBe("just now");
  expect(checkedAgo("2026-10-26T11:59:00Z", now)).toBe("a minute ago");
  expect(checkedAgo("2026-10-26T11:58:00Z", now)).toBe("2 minutes ago");
  expect(checkedAgo("2026-10-26T10:30:00Z", now)).toBe("an hour ago");
  expect(checkedAgo("2026-10-24T12:00:00Z", now)).toBe("2 days ago");
});

test("disk warns under a tenth free", () => {
  expect(diskLow(7 * GB, 98 * GB)).toBe(true);
  expect(diskLow(20 * GB, 98 * GB)).toBe(false);
  expect(diskLow(0, 0)).toBe(false);
  expect(percentOf(91, 98)).toBe(93);
  expect(percentOf(5, 0)).toBe(0);
});
