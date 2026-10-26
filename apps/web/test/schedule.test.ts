import { describe, expect, test } from "bun:test";
import { describeRoutine, describeSchedule } from "../lib/schedule";

test("a routine's schedule reads as words, never as its cron", () => {
  expect(describeSchedule("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
  expect(describeSchedule("30 18 * * *")).toBe("Every day at 6:30 PM");
  expect(describeSchedule("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
  expect(describeSchedule("0 9 * * 1,3,5")).toBe("Mondays, Wednesdays and Fridays at 9:00 AM");
  expect(describeSchedule("0 10 * * 6,0")).toBe("Weekends at 10:00 AM");
  expect(describeSchedule("0 9,17 * * *")).toBe("Every day at 9:00 AM and 5:00 PM");
  expect(describeSchedule("0 0 * * 7")).toBe("Every Sunday at 12:00 AM");
  expect(describeSchedule("0 9 1,15 * *")).toBe("Monthly on the 1st and 15th at 9:00 AM");
  expect(describeSchedule("0 9 11 * *")).toBe("Monthly on the 11th at 9:00 AM");
  expect(describeSchedule("0 9 22 * *")).toBe("Monthly on the 22nd at 9:00 AM");
  expect(describeSchedule("0 * * * *")).toBe("Every hour");
  expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes");
  expect(describeSchedule("0 */4 * * *")).toBe("Every 4 hours");
  for (const odd of ["0 9 * 1 *", "*/5 9-17 * * 1-5", "nonsense", "0 9 1 * 1"]) expect(describeSchedule(odd)).toBe("On a custom schedule");
});

describe("a reminder", () => {
  test("says once and when, not the yearly schedule its cron would read as", () => {
    expect(describeRoutine({ cron: "0 9 * * 1-5", once: false, nextRunAt: null })).toBe("Weekdays at 9:00 AM");
    expect(describeRoutine({ cron: "0 8 24 10 *", once: true, nextRunAt: null })).toBe("Once");
    expect(describeRoutine({ cron: "0 8 24 10 *", once: true, nextRunAt: "2026-10-24T08:00:00Z" })).toMatch(/^Once, .*24/);
  });
});
