import { expect, test } from "bun:test";
import { singleFlight } from "../lib/single-flight";

test("calls made while one runs share a single rerun after it", async () => {
  let runs = 0;
  let release = () => {};
  const load = singleFlight(async () => {
    runs += 1;
    await new Promise<void>((resolve) => (release = resolve));
  });
  const first = load();
  const second = load();
  const third = load();
  expect(second).toBe(third);
  release();
  await first;
  await Promise.resolve();
  release();
  await second;
  expect(runs).toBe(2);
  const fourth = load();
  release();
  await fourth;
  expect(runs).toBe(3);
});

test("a failed run doesn't stop the rerun", async () => {
  let runs = 0;
  const load = singleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error("offline");
  });
  const first = load().catch(() => "failed");
  const second = load();
  expect(await first).toBe("failed");
  await second;
  expect(runs).toBe(2);
});
