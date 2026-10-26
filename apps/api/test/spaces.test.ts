import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Federation, Message, Space, SpaceInvitePreview, Thread } from "@gond/shared";
import { createRelayServer } from "../../../packages/relay/src/server.ts";

/*
 * Spaces end to end: three real Gond APIs, each with its own database, and one relay between them,
 * as on three servers. Ada hosts, Sam and Cy join; lines go round, the rules hold, a Gond that
 * restarts gets what it missed, and the relay never holds a readable word.
 */

type Gond = { name: string; url: string; dir: string; port: number; cookie: string; proc: ReturnType<typeof Bun.spawn> | null; secret: string };

const relayDb = new Database(":memory:", { strict: true });
let relay: ReturnType<typeof createRelayServer>;
const gonds: Gond[] = [];

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function start(gond: Gond) {
  gond.proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(gond.port), APP_URL: gond.url, GOND_DATA_DIR: gond.dir, GOND_SETUP_TOKEN: "spaces-test-token", GOND_SECRET_KEY: gond.secret, GOND_BOX_URL: "", NODE_ENV: "test" },
    stdout: process.env.SPACES_LOG ? Bun.file(path.join(process.env.SPACES_LOG, `${gond.name}.log`)) : "ignore",
    stderr: process.env.SPACES_LOG ? Bun.file(path.join(process.env.SPACES_LOG, `${gond.name}.err`)) : "ignore",
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${gond.url}/api/health`).then((r) => r.ok).catch(() => false);
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error(`${gond.name}'s API didn't start`);
}

async function stop(gond: Gond) {
  gond.proc?.kill();
  await gond.proc?.exited;
  gond.proc = null;
}

async function call<T>(gond: Gond, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${gond.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: gond.url, Cookie: gond.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${gond.name} ${method} ${route}: ${res.status} ${data.error ?? ""}`);
  return data;
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    const value = await check().catch((error: unknown) => ((last = error), null));
    if (value) return value;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? ` (last: ${last.message})` : ""}`);
}

const messages = (gond: Gond, threadId: string) => call<{ messages: Message[] }>(gond, "GET", `/api/threads/${threadId}/messages?limit=200`).then((r) => r.messages);
const said = (gond: Gond, threadId: string, words: string) => until(`"${words}" on ${gond.name}`, async () => (await messages(gond, threadId)).find((m) => m.body.includes(words)));

async function makeGond(name: string): Promise<Gond> {
  const port = await freePort();
  const gond: Gond = { name, port, url: `http://127.0.0.1:${port}`, dir: mkdtempSync(path.join(tmpdir(), `gond-space-${name}-`)), cookie: "", proc: null, secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") };
  await start(gond);
  const res = await fetch(`${gond.url}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: gond.url },
    body: JSON.stringify({ token: "spaces-test-token", username: name.toLowerCase().padEnd(3, "y"), password: "a-long-test-password", confirm: "a-long-test-password" }),
  });
  if (!res.ok) throw new Error(`${name} couldn't register: ${res.status} ${await res.text()}`);
  gond.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await call(gond, "PUT", "/api/spaces/federation", { enabled: true, name: `${name}'s Gond`, relay: "own", relayUrl: relay.url });
  await until(`${name} on the relay`, async () => (await call<{ federation: Federation }>(gond, "GET", "/api/spaces/federation")).federation.state === "ready");
  gonds.push(gond);
  return gond;
}

const bot = (gond: Gond, name: string) => call<{ bot: { id: string; threadId: string } }>(gond, "POST", "/api/bots", { name, color: "#2F6FD6" }).then((r) => r.bot);

let ada: Gond, sam: Gond, cy: Gond;
let room: Thread;
let samThread: Thread;
let cyThread: Thread;
let patch: { id: string };

beforeAll(async () => {
  relay = createRelayServer({ port: 0, hostname: "127.0.0.1", database: relayDb });
  [ada, sam, cy] = await Promise.all([makeGond("Ada"), makeGond("Sam"), makeGond("Cy")]);
}, 60_000);

afterAll(async () => {
  for (const gond of gonds) {
    await stop(gond);
    rmSync(gond.dir, { recursive: true, force: true });
  }
  relay?.stop();
});

describe("spaces between three Gonds", () => {
  test("Ada invites Sam: the invite shows Ada's words, and Sam is let in with his bot", async () => {
    patch = await bot(ada, "Patch");
    const ledger = await bot(ada, "Ledger");
    room = (await call<{ thread: Thread }>(ada, "POST", "/api/rooms", { name: "Trip planning", members: [patch.id, ledger.id] })).thread;
    await call(ada, "POST", `/api/threads/${room.id}/messages`, { body: "private note from before the space" });

    const { invite } = await call<{ invite: { link: string; words: string[] } }>(ada, "POST", "/api/spaces/invites", { threadId: room.id, days: 7 });
    expect(invite.link.startsWith(`${ada.url}/join#`)).toBe(true);
    const adaWords = (await call<{ federation: Federation }>(ada, "GET", "/api/spaces/federation")).federation.words;
    expect(invite.words).toEqual(adaWords!);

    const { preview } = await call<{ preview: SpaceInvitePreview }>(sam, "POST", "/api/spaces/preview", { link: invite.link });
    expect(preview).toMatchObject({ name: "Trip planning", host: { name: "Ada's Gond", words: adaWords } });
    expect(preview.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Patch", "Ledger"]));

    const juniper = await bot(sam, "Juniper");
    // No bot joins a space until its person lets it.
    await call(sam, "PUT", "/api/spaces/defaults", { level: "talk", bots: [juniper.id] });
    samThread = (await call<{ thread: Thread }>(sam, "POST", "/api/spaces/join", { link: invite.link, botIds: [juniper.id] })).thread;
    const space = await until("Sam let in", async () => {
      const { space } = await call<{ space: Space }>(sam, "GET", `/api/spaces/threads/${samThread.id}`);
      return space.status === "active" ? space : null;
    });
    expect(space.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Patch", "Ledger", "ada"]));
    expect(space.gonds.find((g) => g.host)?.name).toBe("Ada's Gond");

    // The invite works once.
    await expect(call(cy, "POST", "/api/spaces/join", { link: invite.link, botIds: [] })).resolves.toBeTruthy();
    const refused = await until("Cy refused", async () => {
      const cyRooms = (await call<{ threads: Thread[] }>(cy, "GET", "/api/threads")).threads.filter((t) => t.space);
      const mine = cyRooms[0];
      return mine?.space?.status === "closed" ? mine : null;
    });
    await call(cy, "DELETE", `/api/rooms/${refused.id}`);

    // Nothing from before the space was made went to Sam.
    expect((await messages(sam, samThread.id)).some((m) => m.body.includes("private note"))).toBe(false);
    const adaSide = await call<{ space: Space }>(ada, "GET", `/api/spaces/threads/${room.id}`);
    expect(adaSide.space.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Juniper", "sam"]));
  }, 60_000);

  test("lines go both ways, marked as from the other Gond, and the relay can't read them", async () => {
    await call(sam, "POST", `/api/threads/${samThread.id}/messages`, { body: "Hello from Sam, the door code is 4471" });
    const arrived = await said(ada, room.id, "Hello from Sam");
    expect(arrived.author.startsWith("remote:")).toBe(true);

    await call(ada, "POST", `/api/threads/${room.id}/messages`, { body: "Hi Sam, welcome in" });
    const back = await said(sam, samThread.id, "Hi Sam, welcome in");
    expect(back.author.startsWith("remote:")).toBe(true);

    const held = relayDb.query("SELECT body FROM relay_queue").all() as { body: string }[];
    expect(held.every((row) => !row.body.includes("4471") && !row.body.includes("welcome in"))).toBe(true);
  }, 30_000);

  test("a third Gond joins and the host passes every line on", async () => {
    const { invite } = await call<{ invite: { link: string } }>(ada, "POST", "/api/spaces/invites", { threadId: room.id, days: 1 });
    cyThread = (await call<{ thread: Thread }>(cy, "POST", "/api/spaces/join", { link: invite.link, botIds: [] })).thread;
    await until("Cy let in", async () => (await call<{ space: Space }>(cy, "GET", `/api/spaces/threads/${cyThread.id}`)).space.status === "active");
    // Cy sees what was said since the space began, and who's there from both other Gonds.
    await said(cy, cyThread.id, "Hello from Sam");
    const cySpace = (await call<{ space: Space }>(cy, "GET", `/api/spaces/threads/${cyThread.id}`)).space;
    expect(cySpace.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Juniper", "Patch", "sam"]));
    expect(cySpace.gonds.map((g) => g.name)).toEqual(expect.arrayContaining(["Ada's Gond", "Sam's Gond"]));

    await call(cy, "POST", `/api/threads/${cyThread.id}/messages`, { body: "Cy here, hello both" });
    await said(ada, room.id, "Cy here");
    await said(sam, samThread.id, "Cy here");
    await until("Sam knows Cy", async () => (await call<{ space: Space }>(sam, "GET", `/api/spaces/threads/${samThread.id}`)).space.gonds.some((g) => g.name === "Cy's Gond"));
  }, 60_000);

  test("checking the words marks that Gond checked for the person who did it, and nobody else", async () => {
    const samKey = (await call<{ space: Space }>(ada, "GET", `/api/spaces/threads/${room.id}`)).space.gonds.find((g) => g.name === "Sam's Gond")!.key;
    await call(ada, "POST", `/api/spaces/gonds/${samKey}/verify`, { verified: true });
    expect((await call<{ space: Space }>(ada, "GET", `/api/spaces/threads/${room.id}`)).space.gonds.find((g) => g.key === samKey)?.verified).toBe(true);
    expect((await call<{ space: Space }>(sam, "GET", `/api/spaces/threads/${samThread.id}`)).space.gonds.every((g) => !g.verified)).toBe(true);
  }, 30_000);

  test("a line that names none of your bots wakes none; one that names a bot gets your rules", async () => {
    const before = (await messages(ada, room.id)).length;
    await call(sam, "POST", `/api/threads/${samThread.id}/messages`, { body: "@patch can you look at trains?" });
    await said(ada, room.id, "@patch can you look at trains?");
    // Ada's Gond has no AI here, so Patch can't answer; it says so on Ada's side only, never to Sam.
    const note = await said(ada, room.id, "Patch couldn't answer");
    expect(note.kind).toBe("event");
    await Bun.sleep(500);
    expect((await messages(sam, samThread.id)).some((m) => m.body.includes("couldn't answer"))).toBe(false);
    expect((await messages(ada, room.id)).length).toBeGreaterThan(before);

    await call(ada, "PUT", `/api/spaces/threads/${room.id}/rules/${patch.id}`, { level: "act", memory: false, botsWake: false });
    await call(sam, "POST", `/api/threads/${samThread.id}/messages`, { body: "@patch please book the table" });
    await said(sam, samThread.id, "I need my owner's OK");
    const card = await until("Ada's card", async () => (await messages(ada, room.id)).find((m) => m.kind === "approval"));
    expect(card.author).toBe(patch.id);
    expect((await messages(sam, samThread.id)).some((m) => m.kind === "approval")).toBe(false);
  }, 60_000);

  test("a Gond that's down gets what it missed when it's back", async () => {
    await stop(sam);
    await call(ada, "POST", `/api/threads/${room.id}/messages`, { body: "While you were away, Sam" });
    await Bun.sleep(400);
    await start(sam);
    await said(sam, samThread.id, "While you were away");
    const copies = (await messages(sam, samThread.id)).filter((m) => m.body.includes("While you were away"));
    expect(copies).toHaveLength(1);
  }, 60_000);

  test("a new space starts with only the bots let into spaces", async () => {
    const helper = await bot(ada, "Helper");
    const started = (await call<{ thread: Thread }>(ada, "POST", "/api/spaces", { name: "Book club", botIds: [helper.id, patch.id] })).thread;
    expect(started.space?.host).toBe(true);
    expect(started.members).toEqual([]);
    await call(ada, "PUT", "/api/spaces/defaults", { level: "talk", bots: [helper.id] });
    const second = (await call<{ thread: Thread }>(ada, "POST", "/api/spaces", { name: "", botIds: [helper.id, patch.id] })).thread;
    expect(second.members).toEqual([helper.id]);
    expect(second.name).toBe("New space");
  }, 30_000);

  test("leaving takes a Gond out for everyone, and the host closing ends it", async () => {
    await call(cy, "POST", `/api/spaces/threads/${cyThread.id}/leave`);
    await said(ada, room.id, "Cy's Gond left");
    await until("Sam sees Cy gone", async () => !(await call<{ space: Space }>(sam, "GET", `/api/spaces/threads/${samThread.id}`)).space.gonds.some((g) => g.name === "Cy's Gond"));

    await call(ada, "POST", `/api/spaces/threads/${room.id}/leave`);
    await until("closed for Sam", async () => (await call<{ space: Space }>(sam, "GET", `/api/spaces/threads/${samThread.id}`)).space.status === "closed");
    await call(sam, "POST", `/api/threads/${samThread.id}/messages`, { body: "anyone still here?" });
    await Bun.sleep(600);
    expect((await messages(ada, room.id)).some((m) => m.body.includes("anyone still here"))).toBe(false);
  }, 60_000);
});
