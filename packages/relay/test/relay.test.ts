import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { RelayClient, createIdentity, inviteToken, keyCard, open, seal, type Identity } from "../src/client.ts";
import { LIMITS, fromB64, inviteHash, parseClientFrame, toB64, type Envelope } from "../src/protocol.ts";
import { createRelayServer } from "../src/server.ts";

// Set GOND_RELAY_TEST_URL (say, to a `wrangler dev` address) to run the flow against the Cloudflare build too.
const OTHER_RELAY = process.env.GOND_RELAY_TEST_URL;

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

function bunRelay(now?: () => number) {
  const database = new Database(":memory:", { strict: true });
  const relay = createRelayServer({ port: 0, hostname: "127.0.0.1", database, now });
  stops.push(() => relay.stop());
  return { ...relay, database };
}

type Inbox = { client: RelayClient; got: Envelope[]; next: (count?: number) => Promise<Envelope[]> };

function connect(url: string, identity: Identity, onEnvelope?: (e: Envelope) => void): Inbox {
  const got: Envelope[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  const client = new RelayClient({
    url,
    identity,
    timeoutMs: 5000,
    onEnvelope: (envelope) => {
      onEnvelope?.(envelope);
      got.push(envelope);
      for (const w of waiting.filter((w) => got.length >= w.count)) w.resolve();
    },
  });
  client.start();
  stops.push(() => client.stop());
  const next = (count = got.length + 1) =>
    got.length >= count ? Promise.resolve(got) : new Promise<Envelope[]>((resolve) => waiting.push({ count, resolve: () => resolve(got) }));
  return { client, got, next };
}

async function ready(inbox: Inbox) {
  // A control request waits for the socket to be ready; forgetting a key nobody allowed is harmless.
  await inbox.client.forget(toB64(new Uint8Array(32)));
}

describe("sealing", () => {
  test("only the recipient opens it, and it says who sent it", async () => {
    const ada = await createIdentity();
    const bo = await createIdentity();
    const envelope = await seal(ada, await keyCard(bo), { line: "Lunch at 1?" });
    expect(envelope.ct).not.toContain("Lunch");
    expect(await open(bo, envelope)).toMatchObject({ from: ada.key, body: { line: "Lunch at 1?" } });
    await expect(open(ada, envelope)).rejects.toThrow();
    const cy = await createIdentity();
    await expect(open(cy, { ...envelope, to: cy.key })).rejects.toThrow();
  });

  test("a changed byte, header or signature is caught", async () => {
    const ada = await createIdentity();
    const bo = await createIdentity();
    const envelope = await seal(ada, await keyCard(bo), "hi");
    const ct = fromB64(envelope.ct);
    ct[0] ^= 1;
    await expect(open(bo, { ...envelope, ct: toB64(ct) })).rejects.toThrow();
    await expect(open(bo, { ...envelope, at: envelope.at + 1 })).rejects.toThrow();
    const mallory = await createIdentity();
    await expect(open(bo, { ...envelope, from: mallory.key })).rejects.toThrow();
  });

  test("a key card whose box key someone else signed is refused", async () => {
    const bo = await createIdentity();
    const mallory = await createIdentity();
    const forged = { ...(await keyCard(bo)), box: mallory.box };
    await expect(seal(await createIdentity(), forged, "hi")).rejects.toThrow();
  });
});

describe("frames", () => {
  test("anything not shaped like a frame is dropped", () => {
    expect(parseClientFrame("not json")).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: "hello", key: "short", sig: "x" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: "send", envelope: { v: 2 } }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: "what" }))).toBeNull();
    expect(parseClientFrame("x".repeat(LIMITS.frameBytes + 1))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: "ping" }))).toEqual({ t: "ping" });
  });
});

const targets: [string, () => Promise<string>][] = [["self-hosted", async () => bunRelay().url]];
if (OTHER_RELAY) targets.push([OTHER_RELAY, async () => OTHER_RELAY]);

describe.each(targets)("the relay (%s)", (_name, start) => {
  test("an invite lets one sender in, and the envelope arrives sealed", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    const adaBox = connect(url, ada);
    const boBox = connect(url, bo);
    const token = inviteToken();
    expect(await adaBox.client.invite(token, Date.now() + 60_000)).toEqual({ ok: true });
    await ready(boBox);

    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "no invite"))).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), { hello: "Ada" }), token)).toEqual({ ok: true });
    const [arrived] = await adaBox.next(1);
    expect(await open(ada, arrived!)).toMatchObject({ from: bo.key, body: { hello: "Ada" } });

    // Now allowed, Bo writes freely; the invite itself is spent.
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "again"))).toEqual({ ok: true });
    const mallory = await createIdentity();
    const malloryBox = connect(url, mallory);
    expect(await malloryBox.client.send(await seal(mallory, await keyCard(ada), "me too"), token)).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  test("an invite taken back by its hash lets nobody in, and a forgotten sender is shut out again", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    const adaBox = connect(url, ada);
    const boBox = connect(url, bo);
    const token = inviteToken();
    await adaBox.client.invite(token, Date.now() + 60_000);
    expect(await adaBox.client.uninviteHash(await inviteHash(token))).toEqual({ ok: true });
    await ready(boBox);
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "late"), token)).toMatchObject({ ok: false, reason: "not_allowed" });

    await adaBox.client.allow(bo.key);
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "allowed"))).toEqual({ ok: true });
    await adaBox.client.forget(bo.key);
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "after"))).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  test("what arrives while a server is away waits, in order, and goes once it's acked", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    const adaFirst = connect(url, ada);
    expect(await adaFirst.client.allow(bo.key)).toEqual({ ok: true });
    adaFirst.client.stop();

    const boBox = connect(url, bo);
    for (const line of ["one", "two", "three"]) expect(await boBox.client.send(await seal(bo, await keyCard(ada), line))).toEqual({ ok: true });

    const adaBack = connect(url, ada);
    const got = await adaBack.next(3);
    expect(await Promise.all(got.map(async (e) => (await open(ada, e)).body))).toEqual(["one", "two", "three"]);
    adaBack.client.stop();

    // Acked, so a later connection gets nothing again.
    const adaAgain = connect(url, ada);
    await ready(adaAgain);
    await Bun.sleep(150);
    expect(adaAgain.got).toHaveLength(0);
  });

  test("an envelope whose handling failed comes again", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    let fail = true;
    const failing = new RelayClient({
      url,
      identity: ada,
      onEnvelope: () => {
        if (fail) throw new Error("disk full");
      },
    });
    failing.start();
    stops.push(() => failing.stop());
    await failing.allow(bo.key);
    const boBox = connect(url, bo);
    await boBox.client.send(await seal(bo, await keyCard(ada), "important"));
    await Bun.sleep(150);
    failing.stop();
    fail = false;

    const adaBack = connect(url, ada);
    const [again] = await adaBack.next(1);
    expect((await open(ada, again!)).body).toBe("important");
  });

  test("a socket can only send as the key it proved, and only signed envelopes", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    connect(url, ada);
    const boBox = connect(url, bo);
    const asAda = await seal(ada, await keyCard(bo), "pretending");
    expect(await boBox.client.send(asAda)).toMatchObject({ ok: false, reason: "not_yours" });
    const real = await seal(bo, await keyCard(ada), "real");
    expect(await boBox.client.send({ ...real, ct: real.ct.slice(0, -2) + "AA" })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("a hello signed by the wrong key is shut out", async () => {
    const url = await start();
    const ada = await createIdentity();
    const mallory = await createIdentity();
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/v1/connect?key=${ada.key}`);
    const closed = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));
    socket.onmessage = async (event) => {
      const frame = JSON.parse(String(event.data)) as { t: string; nonce: string };
      if (frame.t !== "challenge") return;
      const key = await crypto.subtle.importKey("pkcs8", fromB64(mallory.secret), { name: "Ed25519" }, false, ["sign"]);
      const sig = toB64(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`gond-relay/1 hello\n${frame.nonce}`)));
      socket.send(JSON.stringify({ t: "hello", key: ada.key, sig }));
    };
    expect(await closed).toBe(4003);
  });

  test("a second connection for the same key takes over", async () => {
    const url = await start();
    const ada = await createIdentity();
    const bo = await createIdentity();
    const first = connect(url, ada);
    await first.client.allow(bo.key);
    const second = connect(url, ada);
    await ready(second);
    const boBox = connect(url, bo);
    await boBox.client.send(await seal(bo, await keyCard(ada), "which one?"));
    await second.next(1);
    expect(second.got).toHaveLength(1);
  });
});

describe("the client", () => {
  test("envelopes reach the handler one at a time, in order, however long each takes", async () => {
    const relay = bunRelay();
    const ada = await createIdentity();
    const bo = await createIdentity();
    await connect(relay.url, ada).client.allow(bo.key);
    stops.pop()!();
    const boBox = connect(relay.url, bo);
    for (const n of [1, 2, 3, 4]) await boBox.client.send(await seal(bo, await keyCard(ada), n));

    const order: unknown[] = [];
    let running = 0;
    let overlapped = false;
    const done = Promise.withResolvers<void>();
    const client = new RelayClient({
      url: relay.url,
      identity: ada,
      onEnvelope: async (envelope) => {
        overlapped ||= running++ > 0;
        await Bun.sleep(Math.random() * 40);
        order.push((await open(ada, envelope)).body);
        running--;
        if (order.length === 4) done.resolve();
      },
    });
    client.start();
    stops.push(() => client.stop());
    await done.promise;
    expect(order).toEqual([1, 2, 3, 4]);
    expect(overlapped).toBe(false);
  });

  test("a handler that asks the relay something while it handles an envelope gets its answer", async () => {
    const relay = bunRelay();
    const ada = await createIdentity();
    const bo = await createIdentity();
    const cy = await createIdentity();
    const answered = Promise.withResolvers<unknown>();
    const client: RelayClient = new RelayClient({
      url: relay.url,
      identity: ada,
      timeoutMs: 2000,
      onEnvelope: async () => answered.resolve(await client.allow(cy.key)),
    });
    client.start();
    stops.push(() => client.stop());
    await client.allow(bo.key);
    const boBox = connect(relay.url, bo);
    await boBox.client.send(await seal(bo, await keyCard(ada), "hello"));
    expect(await answered.promise).toEqual({ ok: true });
  });

  test("a request made while the relay is down goes through once it's back", async () => {
    const database = new Database(":memory:", { strict: true });
    const first = createRelayServer({ port: 0, hostname: "127.0.0.1", database });
    const { port } = first.server;
    first.stop();
    const ada = await createIdentity();
    const client = new RelayClient({ url: `http://127.0.0.1:${port}`, identity: ada, onEnvelope: () => undefined, timeoutMs: 8000 });
    client.start();
    stops.push(() => client.stop());
    const asked = client.allow((await createIdentity()).key);
    await Bun.sleep(300);
    const back = createRelayServer({ port, hostname: "127.0.0.1", database });
    stops.push(() => back.stop());
    expect(await asked).toEqual({ ok: true });
  });

  test("a client another connection replaced stays off instead of taking the mailbox back", async () => {
    const relay = bunRelay();
    const ada = await createIdentity();
    const states: string[] = [];
    const first = new RelayClient({ url: relay.url, identity: ada, onEnvelope: () => undefined, onState: (state) => states.push(state) });
    first.start();
    stops.push(() => first.stop());
    await first.forget(ada.key);
    const second = connect(relay.url, ada);
    await ready(second);
    await Bun.sleep(1600);
    expect(states.at(-1)).toBe("replaced");
    expect(await second.client.forget(ada.key)).toEqual({ ok: true });
  });
});

describe("the self-hosted relay's limits", () => {
  test("a key that sends too fast is slowed, and the next minute it's fine", async () => {
    let clock = 1_000_000_000_000;
    const relay = bunRelay(() => clock);
    const ada = await createIdentity();
    const bo = await createIdentity();
    connect(relay.url, ada).client.allow(bo.key);
    const boBox = connect(relay.url, bo);
    await ready(boBox);
    for (let i = 0; i < LIMITS.sendsPerMinute; i++) expect(relay.store.spend(bo.key)).toBe(true);
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "one more"))).toMatchObject({ ok: false, reason: "rate_limited" });
    clock += 60_000;
    expect(await boBox.client.send(await seal(bo, await keyCard(ada), "one more"))).toEqual({ ok: true });
  });

  test("frames with a bad signature spend the sender's minute too", async () => {
    const clock = 1_000_000_000_000;
    const relay = bunRelay(() => clock);
    const ada = await createIdentity();
    const bo = await createIdentity();
    await connect(relay.url, ada).client.allow(bo.key);
    const boBox = connect(relay.url, bo);
    const real = await seal(bo, await keyCard(ada), "real");
    const forged = { ...real, ct: real.ct.slice(0, -2) + "AA" };
    for (let i = 0; i < LIMITS.sendsPerMinute; i++) {
      expect(await boBox.client.send({ ...forged, id: `forged-${i}` })).toMatchObject({ ok: false, reason: "bad_signature" });
    }
    expect(await boBox.client.send(real)).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  test("nothing it keeps can be read, and what waits too long goes", async () => {
    let clock = 1_000_000_000_000;
    const relay = bunRelay(() => clock);
    const ada = await createIdentity();
    const bo = await createIdentity();
    const adaBox = connect(relay.url, ada);
    await adaBox.client.allow(bo.key);
    adaBox.client.stop();
    const boBox = connect(relay.url, bo);
    await boBox.client.send(await seal(bo, await keyCard(ada), { secret: "the door code is 4471" }));

    const held = relay.database.query("SELECT body FROM relay_queue").all() as { body: string }[];
    expect(held).toHaveLength(1);
    expect(held[0]!.body).not.toContain("4471");

    clock += LIMITS.queueMs + 1;
    relay.store.sweep();
    expect(relay.store.pending(ada.key)).toHaveLength(0);
  });

  test("a mailbox nobody opens for months is removed with its allowed keys", async () => {
    let clock = 1_000_000_000_000;
    const relay = bunRelay(() => clock);
    const ada = await createIdentity();
    const bo = await createIdentity();
    const adaBox = connect(relay.url, ada);
    await adaBox.client.allow(bo.key);
    adaBox.client.stop();
    expect(relay.store.allows(ada.key, bo.key)).toBe(true);
    clock += LIMITS.idleMs + 1;
    relay.store.sweep();
    expect(relay.store.allows(ada.key, bo.key)).toBe(false);
  });

  test("an envelope over the size limit is refused before it's held", async () => {
    const relay = bunRelay();
    const ada = await createIdentity();
    const bo = await createIdentity();
    await connect(relay.url, ada).client.allow(bo.key);
    const boBox = connect(relay.url, bo);
    const big = await seal(bo, await keyCard(ada), "x".repeat(LIMITS.envelopeBytes));
    // Too big for one frame, so the socket's own limit stops it before the relay reads it.
    await expect(boBox.client.send(big)).rejects.toThrow();
  });
});

describe("a connection that dies quietly", () => {
  test("is pinged, and made again when its pong doesn't come", async () => {
    const identity = await createIdentity();
    let connections = 0;
    let pings = 0;
    // A relay that lets the client in, then stops answering, as a socket a router dropped would.
    const silent = Bun.serve({
      port: 0,
      fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open(ws) {
          connections += 1;
          ws.send(JSON.stringify({ t: "challenge", nonce: "AAAA" }));
        },
        message(ws, data) {
          const frame = JSON.parse(String(data)) as { t: string };
          if (frame.t === "hello") ws.send(JSON.stringify({ t: "ready" }));
          if (frame.t === "ping") pings += 1;
        },
      },
    });
    const states: string[] = [];
    const client = new RelayClient({ url: `http://127.0.0.1:${silent.port}`, identity, onEnvelope: () => {}, onState: (s) => states.push(s), pingMs: 40, pongMs: 60 });
    try {
      client.start();
      const end = Date.now() + 5000;
      while (connections < 2 && Date.now() < end) await Bun.sleep(20);
      expect(pings).toBeGreaterThan(0);
      expect(connections).toBe(2);
      expect(states).toContain("closed");
    } finally {
      client.stop();
      silent.stop(true);
    }
  });

  test("stays up while its pongs come", async () => {
    const relay = createRelayServer({ port: 0, hostname: "127.0.0.1", database: new Database(":memory:") });
    const identity = await createIdentity();
    const states: string[] = [];
    const client = new RelayClient({ url: relay.url, identity, onEnvelope: () => {}, onState: (s) => states.push(s), pingMs: 30, pongMs: 200 });
    try {
      client.start();
      await Bun.sleep(400);
      expect(states).toEqual(["connecting", "ready"]);
    } finally {
      client.stop();
      relay.stop();
    }
  });
});
