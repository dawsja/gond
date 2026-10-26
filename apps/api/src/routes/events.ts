import type { LiveEvent } from "@gond/shared";
import { Hono } from "hono";
import { personId, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { personOf } from "../data/profiles.ts";
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

const NUDGE_MS = 1_500;

export function eventsRoutes() {
  const app = new Hono<Env>();
  app.get("/events", (c) => {
    const me = userId(c);
    const person = personId(c);
    // The person's other profiles reach this page only as their notices and a nudge that something
    // there changed, for the switcher's badges; never what they hold.
    const mine = new Map<string, boolean>();
    const isMine = (owner: string) => {
      let known = mine.get(owner);
      if (known === undefined) mine.set(owner, (known = personOf(owner) === person));
      return known;
    };
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
        let nudging: ReturnType<typeof setTimeout> | null = null;
        const nudge = () => {
          nudging ??= setTimeout(() => {
            nudging = null;
            send(frame({ topic: "profiles", userId: person }));
          }, NUDGE_MS);
        };
        const unsubscribe = subscribe((event) => {
          if (event.topic === "profiles") {
            if (event.userId === person) send(frame(event));
            return;
          }
          const owner = "userId" in event ? event.userId : "threadId" in event && event.threadId ? ownerOf(event.threadId) : me;
          if (owner === me) return send(frame(event));
          if (!owner || !isMine(owner)) return;
          if (event.topic === "notify") send(frame(event));
          else if (event.topic === "thread") nudge();
        });

        const keepalive = setInterval(() => send("event: ping\ndata: {}\n\n"), KEEPALIVE_MS);
        cleanup = () => {
          clearInterval(keepalive);
          if (nudging) clearTimeout(nudging);
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
