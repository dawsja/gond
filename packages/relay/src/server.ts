import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { challenge, createStore, ownerFrame, provesKey, receive, type Sql, type SqlValue, type Store } from "./mailbox.ts";
import { LIMITS, VERSIONS, info, isKey, parseClientFrame, type RelayFrame } from "./protocol.ts";

/**
 * gond-relay on your own machine: one Bun process, every mailbox in one SQLite file. Run it
 * with Docker (packages/relay/Dockerfile) or `bun run src/server.ts`; Gond servers point at its
 * address. The Cloudflare build (worker.ts) is the same mailboxes over Durable Objects.
 */

type Socket = { key: string; nonce: string; authed: boolean; timer?: ReturnType<typeof setTimeout>; turn: Promise<void> };

export type RelayServerOptions = { port?: number; hostname?: string; dataDir?: string; database?: Database; now?: () => number };

export function sqlOf(db: Database): Sql {
  return {
    all: (query, ...params) => db.query(query).all(...params) as Record<string, SqlValue>[],
    run: (query, ...params) => void db.query(query).run(...params),
  };
}

export function createRelayServer(options: RelayServerOptions = {}) {
  const db = options.database ?? openDatabase(options.dataDir ?? "data");
  const store: Store = createStore(sqlOf(db), options.now);
  const owners = new Map<string, ServerWebSocket<Socket>>();

  const send = (ws: ServerWebSocket<Socket>, frame: RelayFrame) => void ws.send(JSON.stringify(frame));


  const server = Bun.serve<Socket>({
    port: options.port ?? 8791,
    hostname: options.hostname,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/connect") {
        const key = url.searchParams.get("key");
        if (!isKey(key)) return Response.json({ error: "Connect with your server's key as ?key=" }, { status: 400 });
        if (server.upgrade(request, { data: { key, nonce: challenge().nonce, authed: false, turn: Promise.resolve() } })) return undefined;
        return Response.json({ error: "This address takes a WebSocket" }, { status: 426 });
      }
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === "/" || url.pathname === "/v1") return Response.json(info());
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    websocket: {
      maxPayloadLength: LIMITS.frameBytes,
      open(ws) {
        send(ws, { t: "challenge", nonce: ws.data.nonce, versions: VERSIONS });
        ws.data.timer = setTimeout(() => ws.close(4001, "No hello"), LIMITS.helloMs);
      },
      message(ws, raw) {
        // Signatures are checked asynchronously, so each socket's frames wait their turn and keep their order.
        ws.data.turn = ws.data.turn.then(() => handle(ws, typeof raw === "string" ? raw : new TextDecoder().decode(raw))).catch(() => ws.close(1011, "Something went wrong"));
      },
      close(ws) {
        clearTimeout(ws.data.timer);
        if (owners.get(ws.data.key) === ws) owners.delete(ws.data.key);
      },
    },
  });

  async function handle(ws: ServerWebSocket<Socket>, raw: string) {
    const frame = parseClientFrame(raw);
    if (!ws.data.authed) {
      if (!(await provesKey(ws.data.key, ws.data.nonce, frame))) return ws.close(4003, "That key wasn't proved");
      clearTimeout(ws.data.timer);
      ws.data.authed = true;
      // One socket per mailbox: a reconnecting server takes over from its old socket.
      owners.get(ws.data.key)?.close(4000, "Replaced by a newer connection");
      owners.set(ws.data.key, ws);
      store.touch(ws.data.key);
      const pending = store.pending(ws.data.key);
      send(ws, { t: "ready", key: ws.data.key, queued: pending.length });
      for (const envelope of pending) send(ws, { t: "deliver", envelope });
      return;
    }
    if (!frame) return send(ws, { t: "error", message: "That frame isn't one this relay reads." });
    const reply = await ownerFrame(store, ws.data.key, frame, async (envelope, invite) => {
      const refused = receive(store, envelope, invite);
      const owner = owners.get(envelope.to);
      if (!refused && owner) send(owner, { t: "deliver", envelope });
      return refused;
    });
    if (reply) send(ws, reply);
  }

  const sweeper = setInterval(() => store.sweep(), 60 * 60 * 1000);
  store.sweep();

  return {
    server,
    store,
    url: `http://${server.hostname}:${server.port}`,
    stop() {
      clearInterval(sweeper);
      server.stop(true);
      if (!options.database) db.close();
    },
  };
}

function openDatabase(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "relay.db"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  return db;
}

if (import.meta.main) {
  const relay = createRelayServer({
    port: Number(process.env.GOND_RELAY_PORT || 8791),
    hostname: process.env.GOND_RELAY_HOST || "0.0.0.0",
    dataDir: process.env.GOND_RELAY_DATA_DIR || "data",
  });
  console.info(`[gond-relay] listening on ${relay.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (relay.stop(), process.exit(0)));
}
