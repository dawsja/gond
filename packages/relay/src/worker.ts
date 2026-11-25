import { info, parsePush, type UsageTotals as Totals } from "./protocol.ts";
import { createFcm, createPushLimiter, handlePush, type Fcm, type PushLimiterStore } from "./push.ts";
import type { SqlValue } from "./sql.ts";
import { createUsageStore, handleUsage, usageJson, type UsageStore } from "./usage.ts";

// The few Workers types this file uses, so it typechecks without @cloudflare/workers-types.
interface DurableObjectState {
  storage: {
    sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] } };
  };
}
interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
type Env = { PUSH: DurableObjectNamespace; USAGE: DurableObjectNamespace; FCM_SERVICE_ACCOUNT?: string };

const PUSH = "https://push.internal/push";
const USAGE_REPORT = "https://usage.internal/report";
const USAGE_TOTALS = "https://usage.internal/totals";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/push" && request.method === "POST") {
      const raw = await request.json().catch(() => null);
      const push = parsePush(raw);
      if (!push) return Response.json({ error: "That isn't a version 1 push." }, { status: 400 });
      return env.PUSH.get(env.PUSH.idFromName(push.from)).fetch(PUSH, { method: "POST", body: JSON.stringify(push) });
    }
    // The public count lives in one Durable Object, so every report and read sees the same total.
    const usage = () => env.USAGE.get(env.USAGE.idFromName("totals"));
    if (url.pathname === "/v1/usage" && request.method === "POST") return usage().fetch(USAGE_REPORT, { method: "POST", body: await request.text() });
    if (url.pathname === "/v1/usage") return usageJson((await (await usage().fetch(USAGE_TOTALS)).json()) as Totals);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/" || url.pathname === "/v1") return Response.json(info());
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

export class PushLimiter {
  private readonly limiter: PushLimiterStore;
  private fcm: Fcm | null | undefined;

  constructor(
    ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const sql = ctx.storage.sql;
    this.limiter = createPushLimiter({
      all: (query, ...params) => sql.exec(query, ...params).toArray(),
      run: (query, ...params) => void sql.exec(query, ...params).toArray(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (this.fcm === undefined) this.fcm = this.env.FCM_SERVICE_ACCOUNT ? createFcm(this.env.FCM_SERVICE_ACCOUNT) : null;
    const answer = await handlePush(await request.json().catch(() => null), {
      fcm: this.fcm,
      spend: (key, limit) => this.limiter.spend(key, limit),
      now: Date.now,
    });
    return Response.json(answer.body, { status: answer.status });
  }
}

export class UsageTotals {
  private readonly store: UsageStore;

  constructor(ctx: DurableObjectState) {
    const sql = ctx.storage.sql;
    this.store = createUsageStore({
      all: (query, ...params) => sql.exec(query, ...params).toArray(),
      run: (query, ...params) => void sql.exec(query, ...params).toArray(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.url === USAGE_TOTALS) return Response.json(this.store.totals());
    const answer = await handleUsage(await request.json().catch(() => null), this.store);
    return Response.json(answer.body, { status: answer.status });
  }
}
