import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createIdentity, pushRequest, usageReport } from "../src/client.ts";
import { LIMITS, fromB64, signedPush } from "../src/protocol.ts";
import { createFcm, createPushLimiter, handlePush, type Fcm } from "../src/push.ts";
import type { Sql, SqlValue } from "../src/sql.ts";
import { createUsageStore, handleUsage, usageJson } from "../src/usage.ts";
import worker, { PushLimiter, UsageTotals } from "../src/worker.ts";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

function sqlOf(db: Database): Sql {
  return {
    all: (query, ...params) => db.query(query).all(...params) as Record<string, SqlValue>[],
    run: (query, ...params) => void db.query(query).run(...params),
  };
}

function testRelay(options: { now?: () => number; fcm?: Fcm } = {}) {
  const db = new Database(":memory:", { strict: true });
  const sql = sqlOf(db);
  const limiter = createPushLimiter(sql, options.now);
  const usage = createUsageStore(sql, options.now);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/push" && request.method === "POST") {
        const answer = await handlePush(await request.json().catch(() => null), {
          fcm: options.fcm ?? null,
          spend: (key, limit) => limiter.spend(key, limit),
          now: limiter.now,
        });
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname === "/v1/usage" && request.method === "POST") {
        const answer = await handleUsage(await request.json().catch(() => null), usage);
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname === "/v1/usage") return usageJson(usage.totals());
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => {
    server.stop(true);
    db.close();
  });
  return { url: `http://${server.hostname}:${server.port}`, usage, limiter };
}

function doNamespace<T extends { fetch(request: Request): Promise<Response> }>(
  create: (ctx: { storage: { sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] } } } }) => T,
) {
  const objects = new Map<string, T>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      const key = String(id);
      let obj = objects.get(key);
      if (!obj) {
        const db = new Database(":memory:", { strict: true });
        stops.push(() => db.close());
        obj = create({
          storage: {
            sql: {
              exec: (query, ...bindings) => ({ toArray: () => db.query(query).all(...bindings) as Record<string, SqlValue>[] }),
            },
          },
        });
        objects.set(key, obj);
      }
      return {
        fetch: (input: string | Request, init?: RequestInit) => obj!.fetch(input instanceof Request ? input : new Request(input, init)),
      };
    },
  };
}

describe("push", () => {
  type Sent = { token: string; data: Record<string, string>; collapse: string | null; kind?: { platform: string; quiet: boolean } };
  function fakeFcm(result: "sent" | "gone" | "failed" = "sent") {
    const sent: Sent[] = [];
    return { sent, fcm: { send: async (token: string, data: Record<string, string>, collapse: string | null, kind?: { platform: "android" | "ios"; quiet: boolean }) => (sent.push({ token, data, collapse, kind }), result) } };
  }
  const post = (url: string, body: unknown) => fetch(`${url}/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const token = "fcm-token-1234567890:abcdefghij";

  test("a Gond's signed push goes to the phone's token with its sealed notice, and nothing else does", async () => {
    const { sent, fcm } = fakeFcm();
    const relay = testRelay({ fcm });
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

  test("a push from a Gond that predates quiet pushes signs exactly as it did", () => {
    const unsigned = { v: 1 as const, from: "k".repeat(43), at: 1, id: "abcdefgh", platform: "android" as const, token, data: "YQ", collapse: null };
    expect(new TextDecoder().decode(signedPush(unsigned))).toBe(["gond-relay/1 push", "abcdefgh", "k".repeat(43), "1", "android", token, "YQ", ""].join("\n"));
    expect(new TextDecoder().decode(signedPush({ ...unsigned, quiet: true }))).toEndWith("\nquiet");
  });

  test("pushes are counted per Gond, a token the phone gave up says so, and a relay without Firebase says it can't", async () => {
    const gone = fakeFcm("gone");
    let clock = 1_000_000;
    const relay = testRelay({ fcm: gone.fcm, now: () => clock });
    const gond = await createIdentity();
    const first = await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at: clock }));
    expect(first.status).toBe(410);
    expect(await first.json()).toEqual({ result: "gone" });
    for (let i = 1; i < LIMITS.pushesPerMinute; i++) await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at: clock }));
    expect((await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at: clock }))).status).toBe(429);
    const another = await createIdentity();
    expect((await post(relay.url, await pushRequest(another, { token, data: "YQ", collapse: null, at: clock }))).status).toBe(410);
    clock += 60_000;
    expect((await post(relay.url, await pushRequest(gond, { token, data: "YQ", collapse: null, at: clock }))).status).toBe(410);

    const bare = testRelay();
    expect((await post(bare.url, await pushRequest(gond, { token, data: "YQ", collapse: null }))).status).toBe(503);
  });

  test("Firebase is reached as the service account, its token kept until it runs out", async () => {
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

describe("usage", () => {
  const post = (url: string, body: unknown) => fetch(`${url}/v1/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("a Gond's signed running total is counted once, grows only so fast, and anyone can read the sum", async () => {
    let clock = 10_000_000;
    const relay = testRelay({ now: () => clock });
    const gond = await createIdentity();
    const other = await createIdentity();

    const first = await post(relay.url, await usageReport(gond, { epoch: "epoch-one", tokens: 1200, at: clock }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: "counted" });
    expect((await post(relay.url, await usageReport(gond, { epoch: "epoch-one", tokens: 5000, at: clock }))).status).toBe(429);
    const forged = await usageReport(gond, { epoch: "epoch-one", tokens: 5000, at: clock });
    expect((await post(relay.url, { ...forged, from: other.key })).status).toBe(401);
    expect((await post(relay.url, await usageReport(other, { epoch: "epoch-two", tokens: 1, at: clock - LIMITS.pushSkewMs - 1 }))).status).toBe(400);
    expect((await post(relay.url, { v: 1, from: gond.key, at: clock, epoch: "epoch-one", tokens: -1, sig: forged.sig })).status).toBe(400);

    clock += LIMITS.usageEveryMs;
    await post(relay.url, await usageReport(gond, { epoch: "epoch-one", tokens: 1200, at: clock }));
    expect(relay.usage.totals().tokens).toBe(1200);
    clock += LIMITS.usageEveryMs;
    await post(relay.url, await usageReport(gond, { epoch: "epoch-one", tokens: 900, at: clock }));
    expect(relay.usage.totals().tokens).toBe(1200);

    clock += 3_600_000;
    await post(relay.url, await usageReport(other, { epoch: "epoch-two", tokens: LIMITS.usageTokensPerHour * 10, at: clock }));
    expect(relay.usage.totals().tokens).toBe(1200 + LIMITS.usageTokensPerHour);

    clock += LIMITS.usageEveryMs;
    await post(relay.url, await usageReport(gond, { epoch: "epoch-three", tokens: 300, at: clock }));
    const { days, ...totals } = relay.usage.totals();
    expect(totals).toEqual({ tokens: 1500 + LIMITS.usageTokensPerHour, gonds: 2, since: 10_000_000 });
    expect(days.reduce((sum, d) => sum + d.tokens, 0)).toBe(totals.tokens);
    expect(days.map((d) => d.day)).toEqual(["1970-01-01"]);

    const read = await fetch(`${relay.url}/v1/usage`);
    expect(read.headers.get("access-control-allow-origin")).toBe("*");
    expect(await read.json()).toEqual(relay.usage.totals());
  });
});

describe("worker", () => {
  test("routes push, usage, healthz and info, and rejects removed connect endpoint", async () => {
    const env: Parameters<typeof worker.fetch>[1] = {
      PUSH: doNamespace((ctx) => new PushLimiter(ctx, env)),
      USAGE: doNamespace((ctx) => new UsageTotals(ctx)),
    };
    const gond = await createIdentity();

    expect((await worker.fetch(new Request("https://api.gond.io/healthz"), env)).status).toBe(200);
    expect(await (await worker.fetch(new Request("https://api.gond.io/v1"), env)).json()).toEqual({ name: "gond-relay", protocol: 1, versions: [1] });
    expect((await worker.fetch(new Request(`https://api.gond.io/v1/connect?key=${gond.key}`), env)).status).toBe(404);

    const report = await usageReport(gond, { epoch: "epoch-one", tokens: 500 });
    const reported = await worker.fetch(new Request("https://api.gond.io/v1/usage", { method: "POST", body: JSON.stringify(report) }), env);
    expect(reported.status).toBe(200);
    const totals = (await (await worker.fetch(new Request("https://api.gond.io/v1/usage"), env)).json()) as { tokens: number; gonds: number };
    expect(totals).toMatchObject({ tokens: 500, gonds: 1 });

    const push = await pushRequest(gond, { token: "fcm-token-1234567890:abcdefghij", data: "YQ", collapse: null });
    const pushed = await worker.fetch(new Request("https://api.gond.io/v1/push", { method: "POST", body: JSON.stringify(push) }), env);
    expect(pushed.status).toBe(503);
    expect((await worker.fetch(new Request("https://api.gond.io/v1/push", { method: "POST", body: "{}" }), env)).status).toBe(400);
  });
});
