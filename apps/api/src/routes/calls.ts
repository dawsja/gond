import { Hono } from "hono";
import type { Env } from "../app.ts";
import { ownThread, userId } from "../access.ts";
import { callOf, endCall, listen, muteCall, ownCall, sendAudio, startCall } from "../calls.ts";

// A tenth of a second of audio is 4.8 KB; anything near this is not a microphone.
const AUDIO_MAX_BYTES = 256 * 1024;
const KEEPALIVE_MS = 20_000;

export function callsRoutes() {
  const app = new Hono<Env>();

  app.get("/call", (c) => c.json({ call: callOf(userId(c)) }));

  app.post("/threads/:id/call", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    const started = startCall(thread, userId(c));
    return started.ok ? c.json({ call: started.call }) : c.json({ error: started.error }, started.status);
  });

  app.get("/calls/:id/stream", (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "Not found" }, 404);
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
    if (!call) return c.json({ error: "Not found" }, 404);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length > AUDIO_MAX_BYTES) return c.json({ error: "Too much audio at once" }, 413);
    if (audio.length % 2) return c.json({ error: "Audio is 16-bit samples" }, 400);
    sendAudio(call.id, audio);
    return c.body(null, 204);
  });

  app.post("/calls/:id/mute", async (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { muted?: unknown } | null;
    if (typeof body?.muted !== "boolean") return c.json({ error: "Say muted: true or false" }, 400);
    muteCall(call.id, body.muted);
    return c.json({ muted: body.muted });
  });

  app.delete("/calls/:id", (c) => {
    const call = ownCall(userId(c), c.req.param("id"));
    if (!call) return c.json({ error: "Not found" }, 404);
    endCall(call.id, null);
    return c.json({ ended: true });
  });

  return app;
}
