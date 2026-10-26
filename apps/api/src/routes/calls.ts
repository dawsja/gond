import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { ownThread, userId } from "../access.ts";
import { activeProfile } from "../data/profiles.ts";
import { getSession, trustedOriginsFor } from "../auth.ts";
import { callOf, endCall, listen, muteCall, ownCall, sendAudio, startCall } from "../calls.ts";

// A tenth of a second of audio is 4.8 KB; anything near this is not a microphone.
const AUDIO_MAX_BYTES = 256 * 1024;
const KEEPALIVE_MS = 20_000;

export function callsRoutes() {
  const app = new Hono<Env>();

  app.get("/call", (c) => c.json({ call: callOf(userId(c)) }));

  app.post("/threads/:id/call", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "Couldn't find that conversation." }, 404);
    const started = startCall(thread, userId(c));
    return started.ok ? c.json({ call: started.call }) : c.json({ error: started.error }, started.status);
  });

  app.get("/calls/:id/stream", (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "That call has ended." }, 404);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        send(": connected\n\n");
        const stop = listen(call.id, (event) => {
          send(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "ended") cleanup();
        });
        const keepalive = setInterval(() => send(": ping\n\n"), KEEPALIVE_MS);
        cleanup = () => {
          clearInterval(keepalive);
          stop();
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };
        c.req.raw.signal.addEventListener("abort", () => cleanup(), { once: true });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  });

  app.post("/calls/:id/audio", async (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "That call has ended." }, 404);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length > AUDIO_MAX_BYTES) return c.json({ error: "That's too much audio at once." }, 413);
    if (audio.length % 2) return c.json({ error: "That isn't audio from the microphone." }, 400);
    sendAudio(call.id, audio);
    return c.body(null, 204);
  });

  app.post("/calls/:id/mute", async (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "That call has ended." }, 404);
    const body = (await c.req.json().catch(() => null)) as { muted?: unknown } | null;
    if (typeof body?.muted !== "boolean") return c.json({ error: "Say whether to mute or unmute." }, 400);
    muteCall(call.id, body.muted);
    return c.json({ muted: body.muted });
  });

  app.delete("/calls/:id", (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "That call has ended." }, 404);
    endCall(call.id, null);
    return c.json({ ended: true });
  });

  return app;
}

const SOCKET_PATH = /^\/api\/calls\/([\w-]{1,80})\/socket$/;

export type CallSocketData = { callId: string; stop: () => void };

// The socket is the open profile's, as every route is: a call belongs to the profile's primary bot.
async function signedInUser(headers: Headers): Promise<string | null> {
  const session = await getSession(headers);
  return session ? activeProfile(session.session.id, session.user.id) : null;
}

/** A proxy may say the socket's scheme (ws, wss) where the page's origin has http or https. */
function socketOrigins(request: Request): string[] {
  return trustedOriginsFor(request).map((origin) => origin.replace(/^ws(s?):/, "http$1:"));
}

/**
 * The call's own socket: the microphone up and the voice down as raw PCM, and its events as JSON, on
 * one connection instead of a POST every few milliseconds and a stream back. Handled ahead of Hono
 * because Bun upgrades from its own server. Null when the request isn't one.
 */
export async function upgradeCallSocket(request: Request, server: Server<CallSocketData>, signedIn = signedInUser): Promise<Response | null | undefined> {
  const match = SOCKET_PATH.exec(new URL(request.url).pathname);
  if (!match || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  // Browsers send the cookie with a WebSocket from any site, so the origin is checked though it's a GET.
  const origin = request.headers.get("origin");
  if (!origin || !socketOrigins(request).includes(origin)) return Response.json({ error: "Cross-site request blocked" }, { status: 403 });
  const who = await signedIn(request.headers);
  if (!who) return Response.json({ error: "Sign in to continue" }, { status: 401 });
  const call = ownCall(who, match[1]!);
  if (!call) return Response.json({ error: "That call has ended." }, { status: 404 });
  return server.upgrade(request, { data: { callId: call.id, stop: () => {} } }) ? undefined : Response.json({ error: "The call couldn't connect." }, { status: 400 });
}

function received(ws: ServerWebSocket<CallSocketData>, message: string | Buffer) {
  if (typeof message !== "string") {
    if (message.length > AUDIO_MAX_BYTES || message.length % 2) return;
    sendAudio(ws.data.callId, message);
    return;
  }
  let event: { type?: unknown; muted?: unknown } | null = null;
  try {
    event = JSON.parse(message) as { type?: unknown; muted?: unknown };
  } catch {
    return;
  }
  if (event?.type === "mute" && typeof event.muted === "boolean") muteCall(ws.data.callId, event.muted);
}

export const callSocket: WebSocketHandler<CallSocketData> = {
  open(ws) {
    ws.data.stop = listen(ws.data.callId, (event) => {
      // The voice goes down as the bytes themselves, a third smaller than base64 in JSON.
      if (event.type === "audio") ws.send(Buffer.from(event.data, "base64"));
      else ws.send(JSON.stringify(event));
      if (event.type === "ended") ws.close(1000, "ended");
    });
  },
  message: received,
  close(ws) {
    ws.data.stop();
  },
};
