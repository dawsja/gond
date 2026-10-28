import { challenge, createStore, ownerFrame, provesKey, receive, type Sql, type SqlValue, type Store } from "./mailbox.ts";
import { LIMITS, info, isKey, parseClientFrame, parseEnvelope, parsePush, type Envelope, type Refusal, type RelayFrame } from "./protocol.ts";
import { createFcm, handlePush, type Fcm } from "./push.ts";

/**
 * gond-relay on Cloudflare (api.gond.io): the Worker sends each socket to the Durable Object
 * named after its key, and that object is the mailbox, with its own SQLite. Sockets use the
 * hibernation API, so an idle Gond holding its connection costs next to nothing. The mailbox
 * logic is mailbox.ts, the same as the self-hosted server's.
 */

// The few Workers types this file uses, so it typechecks without @cloudflare/workers-types.
interface CfSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
interface DurableObjectState {
  storage: {
    sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] } };
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
  acceptWebSocket(socket: CfSocket): void;
  getWebSockets(): CfSocket[];
}
interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
type Env = { MAILBOXES: DurableObjectNamespace; FCM_SERVICE_ACCOUNT?: string };

const WebSocketPair = (globalThis as unknown as { WebSocketPair: new () => { 0: CfSocket; 1: CfSocket } }).WebSocketPair;
const SWEEP_MS = 24 * 60 * 60 * 1000;
// Only a Durable Object calls this; the Worker never forwards it, so nobody outside can.
const RECEIVE = "https://mailbox.internal/receive";
const PUSH = "https://mailbox.internal/push";

type Attachment = { key: string; nonce: string; authed: boolean };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/connect") {
      const key = url.searchParams.get("key");
      if (!isKey(key)) return Response.json({ error: "Connect with your server's key as ?key=" }, { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "This address takes a WebSocket" }, { status: 426 });
      return env.MAILBOXES.get(env.MAILBOXES.idFromName(key)).fetch(request);
    }
    if (url.pathname === "/v1/push" && request.method === "POST") {
      // Each Gond's pushes are counted in the Durable Object named after its key, as its sends are.
      const raw = await request.json().catch(() => null);
      const push = parsePush(raw);
      if (!push) return Response.json({ error: "That isn't a version 1 push." }, { status: 400 });
      return env.MAILBOXES.get(env.MAILBOXES.idFromName(push.from)).fetch(PUSH, { method: "POST", body: JSON.stringify(push) });
    }
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/" || url.pathname === "/v1") return Response.json(info());
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

export class Mailbox {
  private readonly store: Store;
  private fcm: Fcm | null | undefined;
  private readonly turns = new WeakMap<CfSocket, Promise<void>>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const sql = ctx.storage.sql;
    const adapter: Sql = {
      all: (query, ...params) => sql.exec(query, ...params).toArray(),
      run: (query, ...params) => void sql.exec(query, ...params).toArray(),
    };
    this.store = createStore(adapter);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.url === PUSH) {
      if (this.fcm === undefined) this.fcm = this.env.FCM_SERVICE_ACCOUNT ? createFcm(this.env.FCM_SERVICE_ACCOUNT) : null;
      const answer = await handlePush(await request.json(), { fcm: this.fcm, spend: (key, limit) => this.store.spend(key, limit), now: Date.now });
      return Response.json(answer.body, { status: answer.status });
    }
    if (request.url === RECEIVE) {
      const { envelope, invite } = (await request.json()) as { envelope: unknown; invite: string | null };
      const parsed = parseEnvelope(envelope);
      return Response.json({ refused: parsed ? this.take(parsed, invite) : ("bad_envelope" satisfies Refusal) });
    }
    const key = new URL(request.url).searchParams.get("key") ?? "";
    const pair = new WebSocketPair();
    const { nonce, frame } = challenge();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ key, nonce, authed: false } satisfies Attachment);
    pair[1].send(JSON.stringify(frame));
    setTimeout(() => {
      if (!(pair[1].deserializeAttachment() as Attachment).authed) pair[1].close(4001, "No hello");
    }, LIMITS.helloMs);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(ws: CfSocket, raw: string | ArrayBuffer) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    // Asking another mailbox lets other events in meanwhile, so each socket's frames wait their turn and keep their order.
    const turn = (this.turns.get(ws) ?? Promise.resolve()).then(() => this.handle(ws, text)).catch(() => ws.close(1011, "Something went wrong"));
    this.turns.set(ws, turn);
    return turn;
  }

  webSocketClose(ws: CfSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async alarm() {
    this.store.sweep();
    const owner = this.owners()[0];
    const key = owner ? (owner.deserializeAttachment() as Attachment).key : null;
    const left = this.ctx.storage.sql.exec("SELECT (SELECT COUNT(*) FROM relay_mailboxes) + (SELECT COUNT(*) FROM relay_queue) AS n").toArray()[0];
    if (!key && Number(left?.n ?? 0) === 0) return this.ctx.storage.deleteAll();
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private owners(): CfSocket[] {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.authed);
  }

  private send(ws: CfSocket, frame: RelayFrame) {
    ws.send(JSON.stringify(frame));
  }

  /** An envelope for this mailbox, from any mailbox: held, then handed to the owner if it's here. */
  private take(envelope: Envelope, invite: string | null): Refusal | null {
    const refused = receive(this.store, envelope, invite);
    if (!refused) for (const owner of this.owners()) this.send(owner, { t: "deliver", envelope });
    return refused;
  }

  private async handle(ws: CfSocket, raw: string) {
    const attachment = ws.deserializeAttachment() as Attachment;
    const frame = parseClientFrame(raw);
    if (!attachment.authed) {
      if (!(await provesKey(attachment.key, attachment.nonce, frame))) return ws.close(4003, "That key wasn't proved");
      // One socket per mailbox: a reconnecting server takes over from its old socket.
      for (const old of this.owners()) old.close(4000, "Replaced by a newer connection");
      ws.serializeAttachment({ ...attachment, authed: true } satisfies Attachment);
      this.store.touch(attachment.key);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
      const pending = this.store.pending(attachment.key);
      this.send(ws, { t: "ready", key: attachment.key, queued: pending.length });
      for (const envelope of pending) this.send(ws, { t: "deliver", envelope });
      return;
    }
    if (!frame) return this.send(ws, { t: "error", message: "That frame isn't one this relay reads." });
    const reply = await ownerFrame(this.store, attachment.key, frame, async (envelope, invite) => {
      if (envelope.to === attachment.key) return this.take(envelope, invite);
      const answer = await this.env.MAILBOXES.get(this.env.MAILBOXES.idFromName(envelope.to)).fetch(RECEIVE, {
        method: "POST",
        body: JSON.stringify({ envelope, invite }),
      });
      return ((await answer.json()) as { refused: Refusal | null }).refused;
    });
    if (reply) this.send(ws, reply);
  }
}
