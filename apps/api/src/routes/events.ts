import type { LiveEvent } from "@gond/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { threadOwner } from "../data/threads.ts";
import { subscribe } from "../events.ts";

const KEEPALIVE_MS = 25_000;
const RETRY_MS = 3_000;

// A conversation never changes hands, so its owner is read once, not once per listener per event.
const owners = new Map<string, string>();
function ownerOf(threadId: string): string | null {
  const known = owners.get(threadId);
  if (known) return known;
  const owner = threadOwner(threadId);
  if (owner) owners.set(threadId, owner);
  return owner;
}

const serialized = new WeakMap<LiveEvent, string>();
function frame(event: LiveEvent): string {
  let text = serialized.get(event);
  if (!text) serialized.set(event, (text = `data: ${JSON.stringify(event)}\n\n`));
  return text;
}

export function eventsRoutes() {
  const app = new Hono<Env>();
  app.get("/events", (c) => {
    const me = userId(c);
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
        send(`retry: ${RETRY_MS}\n: connected\n\n`);
        const unsubscribe = subscribe((event) => {
          if ("userId" in event && event.userId !== me) return;
          if ("threadId" in event && event.threadId && ownerOf(event.threadId) !== me) return;
          send(frame(event));
        });

        const keepalive = setInterval(() => send("event: ping\ndata: {}\n\n"), KEEPALIVE_MS);
        cleanup = () => {
          clearInterval(keepalive);
          unsubscribe();
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
  return app;
}
