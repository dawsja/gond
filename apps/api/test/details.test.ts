import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { botInputSchema, checkDetail, expiryStage, type DetailRecord } from "@gond/shared";
import { decide } from "../src/approvals.ts";
import { createBot, setPrimary } from "../src/data/bots.ts";
import { getDetail, saveDetail } from "../src/data/details.ts";
import { allSecretValues } from "../src/data/secrets.ts";
import { getThread, listMessages } from "../src/data/threads.ts";
import { ensureDatabase, resetDbReady } from "../src/db/init.ts";
import { closeDb } from "../src/db/sqlite.ts";
import { detailsTools, detailTypeName, runDetailReminders } from "../src/details.ts";
import { heldLoginFor, notePage } from "../src/logins.ts";
import { detailsRoutes } from "../src/routes/details.ts";
import type { Env } from "../src/app.ts";

const OWNER = "u-details";
const STRANGER = "u-details-other";
const PASSPORT = "X1234567Q";

let previous: string | undefined, directory: string;
beforeAll(() => {
  previous = process.env.GOND_DATA_DIR;
  directory = mkdtempSync(join(tmpdir(), "gond-details-"));
  process.env.GOND_DATA_DIR = directory;
  resetDbReady();
  const db = ensureDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);`);
  for (const id of [OWNER, STRANGER]) db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.com`, "user", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
});
afterAll(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.GOND_DATA_DIR;
  else process.env.GOND_DATA_DIR = previous;
  resetDbReady();
});

function as(id: string) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("session", { user: { id } } as never);
    await next();
  });
  return app.route("/api", detailsRoutes());
}

function passport(label = "Maya's passport", expiresOn: string | null = null) {
  const checked = checkDetail({ kind: "document", label, expiresOn, fields: [{ label: "Number", private: true, value: PASSPORT }, { label: "Name on it", private: false, value: "Maya Lopez" }] });
  if ("error" in checked) throw new Error(checked.error);
  const saved = saveDetail(OWNER, checked.detail);
  if ("error" in saved) throw new Error(saved.error);
  return saved;
}

describe("your details", () => {
  test("a private value is never sent back, stays while left empty, and must be typed again to be made readable", async () => {
    const app = as(OWNER);
    const made = (await (await app.request("/api/details", { method: "POST", body: JSON.stringify({ kind: "document", label: "Passport", fields: [{ label: "Number", private: true, value: PASSPORT }, { label: "Issued by", private: false, value: "USA" }] }) })).json()) as { detail: DetailRecord };
    expect(JSON.stringify(made)).not.toContain(PASSPORT);
    const listed = await (await app.request("/api/details")).text();
    expect(listed).not.toContain(PASSPORT);
    expect(listed).toContain("USA");
    const number = made.detail.fields.find((f) => f.label === "Number")!;
    expect(number).toMatchObject({ private: true, saved: true, value: null });

    await app.request(`/api/details/${made.detail.id}`, { method: "PUT", body: JSON.stringify({ kind: "document", label: "Passport", fields: [{ id: number.id, label: "Number", private: true, value: "" }, { label: "Issued by", private: false, value: "Canada" }] }) });
    expect(allSecretValues()).toContain(PASSPORT);
    const opened = (await (await app.request(`/api/details/${made.detail.id}`, { method: "PUT", body: JSON.stringify({ kind: "document", label: "Passport", fields: [{ id: number.id, label: "Number", private: false, value: "" }] }) })).json()) as { detail: DetailRecord };
    expect(opened.detail.fields[0]).toMatchObject({ private: false, saved: false, value: "" });
    expect(allSecretValues()).not.toContain(PASSPORT);

    expect((await as(STRANGER).request(`/api/details/${made.detail.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/details", { method: "POST", body: JSON.stringify({ kind: "person", label: "passport", fields: [{ label: "Name", value: "x" }] }) })).status).toBe(400);
    expect((await app.request(`/api/details/${made.detail.id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("use_details types only on the site the card named, after a yes, and the bot never hears a value", async () => {
    const record = passport();
    const bot = createBot(botInputSchema.parse({ name: "Filler", approval: "full" }), OWNER);
    const thread = getThread(bot.threadId)!;
    const tools = detailsTools({ bot, thread, computer: true });
    const ask = { site: "Camp Oak", details: [{ record: "maya's passport", fields: ["Number", "Name on it"] }], reason: "Maya's camp sign-up" };

    expect(String(await tools.use_details!.execute(ask, "c1"))).toContain("open the form's page");
    expect(String(await tools.use_details!.execute({ ...ask, details: [{ record: "Maya's passport", fields: ["Visa"] }] }, "c2"))).toContain('has no "Visa"');

    notePage(bot.id, "https://www.campoak.org/register");
    const answer = tools.use_details!.execute(ask, "c3");
    await Bun.sleep(5);
    const card = listMessages(bot.threadId).filter((m) => m.kind === "approval").at(-1)!;
    expect(card.body).toContain("campoak.org");
    decide(card.approvalId!, { decision: "allow" });
    const said = String(await answer);
    expect(said).not.toContain(PASSPORT);
    expect(said).toContain("MAYAS_PASSPORT_NUMBER");
    expect(heldLoginFor(thread.id, "MAYAS_PASSPORT_NUMBER")).toEqual({ value: PASSPORT, site: "campoak.org" });

    const listed = String(await tools.list_details!.execute({}, "c4"));
    expect(listed).toContain("Number: private");
    expect(listed).not.toContain(PASSPORT);
    expect(getDetail(OWNER, record.id)).not.toBeNull();
  });

  test("what a bot saves goes in as the detail it names, checked as one", async () => {
    const bot = createBot(botInputSchema.parse({ name: "Keeper", approval: "full" }), OWNER);
    const tools = detailsTools({ bot, thread: getThread(bot.threadId)!, computer: false });
    expect(String(await tools.save_details!.execute({ record: "Leo", kind: "person", fields: [{ label: "Phone", value: "call mom" }] }, "s1"))).toContain("isn't right");
    expect(String(await tools.save_details!.execute({ record: "Leo", kind: "person", fields: [{ label: "DOB", value: "March 3, 2018" }, { label: "Favourite colour", value: "Green" }] }, "s2"))).toContain("Saved to Leo");
    const leo = String(await tools.list_details!.execute({}, "s3"));
    expect(leo).toContain("Date of birth: 2018-03-03");
    expect(leo).toContain("Favourite colour: Green");
  });

  test("a held detail is never called by a card's name", () => {
    const taken = new Set<string>();
    expect(detailTypeName("Card", "Number", taken)).toBe("DETAIL_CARD_NUMBER");
    expect(detailTypeName("Maya", "Phone", taken)).toBe("MAYA_PHONE");
    expect(detailTypeName("maya", "phone", taken)).toBe("MAYA_PHONE_2");
  });

  test("an expiry reminds the main bot once per reminder, in the daytime, and a new date starts over", () => {
    expect(expiryStage("2027-03-01", "2026-11-20")).toBe(null);
    expect(expiryStage("2027-02-01", "2026-11-20")).toBe(90);
    expect(expiryStage("2026-11-25", "2026-11-20")).toBe(7);
    expect(expiryStage("2026-11-01", "2026-11-20")).toBe(0);

    const main = createBot(botInputSchema.parse({ name: "Main" }), OWNER);
    setPrimary(OWNER, main.id);
    const record = passport("Licence", "2026-12-10");
    const prompts = () => listMessages(main.threadId).filter((m) => m.kind === "prompt");
    expect(runDetailReminders(new Date("2026-11-20T03:00:00Z"))).toBe(0);
    expect(runDetailReminders(new Date("2026-11-20T12:00:00Z"))).toBe(1);
    expect(prompts().at(-1)!.body).toContain("Licence");
    expect(prompts().at(-1)!.body).toContain("in 20 days");
    expect(prompts().at(-1)!.body).not.toContain(PASSPORT);
    expect(runDetailReminders(new Date("2026-11-20T13:00:00Z"))).toBe(0);
    expect(runDetailReminders(new Date("2026-12-04T12:00:00Z"))).toBe(1);

    const checked = checkDetail({ kind: "document", label: "Licence", expiresOn: "2031-12-10", fields: [{ label: "Number", private: true, value: "" }] });
    if ("error" in checked) throw new Error(checked.error);
    saveDetail(OWNER, checked.detail, record.id);
    expect(runDetailReminders(new Date("2026-12-05T12:00:00Z"))).toBe(0);
  });
});
