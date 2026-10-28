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

describe("push", () => {
  type Sent = { token: string; data: Record<string, string>; collapse: string | null; kind?: { platform: string; quiet: boolean } };
  function fakeFcm(result: "sent" | "gone" | "failed" = "sent") {
    const sent: Sent[] = [];
    return { sent, fcm: { send: async (token: string, data: Record<string, string>, collapse: string | null, kind?: { platform: "android" | "ios"; quiet: boolean }) => (sent.push({ token, data, collapse, kind }), result) } };
  }
  const post = (url: string, body: unknown) => fetch(`${url}/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const token = "fcm-token-1234567890:abcdefghij";

  test("a Gond's signed push goes to the phone's token with its sealed notice, and nothing else does", async () => {
    const { pushRequest } = await import("../src/client.ts");
    const { sent, fcm } = fakeFcm();
    const relay = createRelayServer({ port: 0, hostname: "127.0.0.1", database: new Database(":memory:", { strict: true }), fcm });
    stops.push(() => relay.stop());
    const gond = await createIdentity();
    const push = await pushRequest(gond, { token, data: "c2VhbGVk", collapse: "t_123" });

    const ok = await post(relay.url, push);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: "sent" });
    expect(sent).toEqual([{ token, data: { d: "c2VhbGVk" }, collapse: "t_123", kind: { platform: "android", quiet: false } }]);

    expect((await post(relay.url, { ...push, data: "b3RoZXI" })).status).toBe(401);
    const other = await createIdentity();
    expect((await post(relay.url, { ...push, from: other.key })).status).toBe(401);
    expect((await post(relay.url, await pushRequest(gond, { token, data: "c2VhbGVk", collapse: null, at: Date.now() - LIMITS.pushSkewMs - 1000 }))).status).toBe(400);
    expect((await post(relay.url, { ...push, platform: "ios" })).status).toBe(401);
    expect((await post(relay.url, { ...push, platform: "windows" })).status).toBe(400);
    expect((await post(relay.url, { ...push, quiet: true })).status).toBe(401);
    expect((await post(relay.url, { ...push, quiet: false })).status).toBe(400);
    expect((await post(relay.url, await pushRequest(gond, { token, data: "x".repeat(LIMITS.pushBytes + 1), collapse: null }))).status).toBe(400);
    expect(sent).toHaveLength(1);

    const iphone = await pushRequest(gond, { token, data: "c2VhbGVk", collapse: "card-ap_1", platform: "ios" });
    expect((await post(relay.url, iphone)).status).toBe(200);
    const withdrawn = await pushRequest(gond, { token, data: "c2VhbGVk", collapse: "card-ap_1", platform: "ios", quiet: true });
    expect((await post(relay.url, withdrawn)).status).toBe(200);
    expect(sent.slice(1).map((s) => s.kind)).toEqual([
      { platform: "ios", quiet: false },
      { platform: "ios", quiet: true },
    ]);
  });

  test("a push from a Gond that predates quiet pushes signs exactly as it did", async () => {
    const { signedPush } = await import("../src/protocol.ts");
    const unsigned = { v: 1 as const, from: "k".repeat(43), at: 1, id: "abcdefgh", platform: "android" as const, token, data: "YQ", collapse: null };
    expect(new TextDecoder().decode(signedPush(unsigned))).toBe(["gond-relay/1 push", "abcdefgh", "k".repeat(43), "1", "android", token, "YQ", ""].join("\n"));
    expect(new TextDecoder().decode(signedPush({ ...unsigned, quiet: true }))).toEndWith("\nquiet");
  });

  test("pushes are counted per Gond, a token the phone gave up says so, and a relay without Firebase says it can't", async () => {
    const { pushRequest } = await import("../src/client.ts");
    const gone = fakeFcm("gone");
    const relay = createRelayServer({ port: 0, hostname: "127.0.0.1", database: new Database(":memory:", { strict: true }), fcm: gone.fcm, now: () => 1_000_000 });
    stops.push(() => relay.stop());
    const gond = await createIdentity();
    const at = 1_000_000;
    const first = await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at }));
    expect(first.status).toBe(410);
    expect(await first.json()).toEqual({ result: "gone" });
    for (let i = 1; i < LIMITS.pushesPerMinute; i++) await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at }));
    expect((await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at }))).status).toBe(429);
    const another = await createIdentity();
    expect((await post(relay.url, await pushRequest(another, { token, data: "YQ", collapse: null, at }))).status).toBe(410);

    const bare = bunRelay();
    expect((await post(bare.url, await pushRequest(gond, { token, data: "YQ", collapse: null }))).status).toBe(503);
  });

  test("Firebase is reached as the service account, its token kept until it runs out", async () => {
    const { createFcm } = await import("../src/push.ts");
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const grants: string[] = [];
    const messages: { auth: string | null; path: string; body: unknown }[] = [];
    const google = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/token") {
          const assertion = new URLSearchParams(await request.text()).get("assertion") ?? "";
          const [head, claims, sig] = assertion.split(".");
          const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, fromB64(sig!), new TextEncoder().encode(`${head}.${claims}`));
          if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
          grants.push(JSON.parse(new TextDecoder().decode(fromB64(claims!))).scope);
          return Response.json({ access_token: `ya29.${grants.length}`, expires_in: 3600 });
        }
        messages.push({ auth: request.headers.get("authorization"), path: url.pathname, body: await request.json() });
        return url.pathname.includes("gone") ? Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }) : Response.json({ name: "projects/p/messages/1" });
      },
    });
    stops.push(() => google.stop(true));
    const base = `http://127.0.0.1:${google.port}`;
    const account = JSON.stringify({ project_id: "gond-test", client_email: "push@gond-test.iam.gserviceaccount.com", private_key: pem, token_uri: `${base}/token` });

    const fcm = createFcm(account, { endpoint: base });
    expect(await fcm.send(token, { d: "YQ" }, "t_1")).toBe("sent");
    expect(await fcm.send(token, { d: "Yg" }, null)).toBe("sent");
    expect(grants).toEqual(["https://www.googleapis.com/auth/firebase.messaging"]);
    expect(messages[0]).toEqual({ auth: "Bearer ya29.1", path: "/v1/projects/gond-test/messages:send", body: { message: { token, data: { d: "YQ" }, android: { priority: "HIGH", ttl: "3600s", collapse_key: "t_1" } } } });
    expect((messages[1]!.body as { message: { android: Record<string, unknown> } }).message.android).toEqual({ priority: "HIGH", ttl: "3600s" });

    // An iPhone gets a placeholder its notification service extension rewrites, or a background push when quiet.
    expect(await fcm.send(token, { d: "YQ" }, "card-ap_1", { platform: "ios", quiet: false })).toBe("sent");
    expect((messages[2]!.body as { message: unknown }).message).toEqual({
      token,
      data: { d: "YQ" },
      apns: {
        headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "card-ap_1" },
        payload: { aps: { alert: { title: "Gond", body: "Something new from your bots." }, sound: "default", "mutable-content": 1 } },
      },
    });
    expect(await fcm.send(token, { d: "YQ" }, null, { platform: "ios", quiet: true })).toBe("sent");
    expect((messages[3]!.body as { message: { apns: unknown } }).message.apns).toEqual({ headers: { "apns-push-type": "background", "apns-priority": "5" }, payload: { aps: { "content-available": 1 } } });

    const gone = createFcm(JSON.stringify({ ...JSON.parse(account), project_id: "gone" }), { endpoint: base });
    expect(await gone.send(token, { d: "YQ" }, null)).toBe("gone");
    expect(() => createFcm("{}")).toThrow();
  });
});
