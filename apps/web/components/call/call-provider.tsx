"use client";

import type { CallEvent, CallInfo } from "@gond/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { api, del, post } from "@/lib/api";
import { CallPlayer, levelOf, startCapture, type Capture } from "@/lib/call-audio";

export type CallPhase = "connecting" | "live";

export type CallView = {
  info: CallInfo;
  phase: CallPhase;
  muted: boolean;
  /** What the person is saying, before it settles into the chat. */
  heard: string;
  /** What the bot's voice is saying, before it settles into the chat. */
  said: string;
  speaking: boolean;
};

type Levels = { you: () => number; bot: () => number };

type CallContext = {
  call: CallView | null;
  levels: Levels;
  start: (threadId: string) => Promise<void>;
  end: () => void;
  toggleMute: () => void;
};

const Context = createContext<CallContext | null>(null);

const SILENT: Levels = { you: () => 0, bot: () => 0 };
// Let a goodbye play out before the speaker goes quiet.
const DRAIN_MS = 4_000;

type Live = {
  info: CallInfo;
  context: AudioContext;
  player: CallPlayer;
  capture: Capture | null;
  source: EventSource | null;
  queue: ArrayBuffer[];
  sending: boolean;
  closed: boolean;
  muted: boolean;
};

/** The microphone goes up in order, one request at a time, whatever piled up while the last was out. */
async function flush(current: Live) {
  if (current.sending) return;
  current.sending = true;
  while (!current.closed && current.queue.length) {
    const parts = current.queue.splice(0);
    const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      body.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    await fetch(`/api/calls/${current.info.id}/audio`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body }).catch(() => undefined);
  }
  current.sending = false;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const [call, setCall] = useState<CallView | null>(null);
  const live = useRef<Live | null>(null);
  const levels = useRef<Levels>(SILENT);

  const teardown = useCallback(async (drain: boolean, reason: string | null) => {
    const current = live.current;
    if (!current || current.closed) return;
    current.closed = true;
    live.current = null;
    current.source?.close();
    current.capture?.stop();
    levels.current = SILENT;
    setCall(null);
    if (drain) await current.player.drained(DRAIN_MS);
    void current.context.close().catch(() => undefined);
    if (reason) toast.add({ type: "error", title: reason });
  }, []);

  const onEvent = useCallback(
    (current: Live, event: CallEvent) => {
      switch (event.type) {
        case "ready":
          setCall((c) => (c && c.info.id === current.info.id ? { ...c, phase: "live" } : c));
          return;
        case "audio":
          current.player.play(event.data);
          return;
        case "interrupt":
          current.player.clear();
          return;
        case "heard":
          setCall((c) => (c && c.info.id === current.info.id ? { ...c, heard: event.text } : c));
          return;
        case "said":
          setCall((c) => (c && c.info.id === current.info.id ? { ...c, said: event.text } : c));
          return;
        case "settled":
          setCall((c) => (c && c.info.id === current.info.id ? { ...c, ...(event.who === "you" ? { heard: "" } : { said: "" }) } : c));
          return;
        case "ended":
          void teardown(true, event.reason);
          return;
      }
    },
    [teardown],
  );

  const start = useCallback(
    async (threadId: string) => {
      if (live.current) await teardown(false, null);
      // Made inside the tap, or the browser keeps it silent.
      const context = new AudioContext();
      let info: CallInfo;
      try {
        info = (await post<{ call: CallInfo }>(`/api/threads/${threadId}/call`)).call;
      } catch (failure) {
        void context.close();
        toast.add({ type: "error", title: failure instanceof Error ? failure.message : "The call couldn't start." });
        return;
      }
      const current: Live = { info, context, player: new CallPlayer(context), capture: null, source: null, queue: [], sending: false, closed: false, muted: false };
      live.current = current;
      setCall({ info, phase: "connecting", muted: false, heard: "", said: "", speaking: false });

      const source = new EventSource(`/api/calls/${info.id}/stream`);
      current.source = source;
      source.onmessage = (message) => {
        try {
          onEvent(current, JSON.parse(message.data as string) as CallEvent);
        } catch {
          /* not an event */
        }
      };
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) void teardown(false, "The call dropped.");
      };

      try {
        current.capture = await startCapture(context, (pcm) => {
          current.queue.push(pcm);
          void flush(current);
        });
      } catch {
        void del(`/api/calls/${info.id}`).catch(() => undefined);
        void teardown(false, "The microphone is blocked. Allow it for this site, then call again.");
        return;
      }
      if (current.closed) {
        current.capture.stop();
        return;
      }
      const buffer = new Float32Array(512);
      const mic = current.capture.analyser;
      levels.current = { you: () => levelOf(mic, buffer), bot: () => levelOf(current.player.analyser, buffer) };
    },
    [onEvent, teardown],
  );

  const end = useCallback(() => {
    const current = live.current;
    if (!current) return;
    void del(`/api/calls/${current.info.id}`).catch(() => undefined);
    void teardown(false, null);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const current = live.current;
    if (!current) return;
    current.muted = !current.muted;
    const muted = current.muted;
    current.capture?.setMuted(muted);
    void api(`/api/calls/${current.info.id}/mute`, { method: "POST", body: JSON.stringify({ muted }) }).catch(() => undefined);
    setCall((c) => (c ? { ...c, muted } : c));
  }, []);

  // Whether the bot is talking is the player's to say; read it often enough for the label.
  const callId = call?.info.id;
  useEffect(() => {
    if (!callId) return;
    const timer = window.setInterval(() => {
      const speaking = live.current?.player.speaking ?? false;
      setCall((c) => (c && c.speaking !== speaking ? { ...c, speaking } : c));
    }, 200);
    return () => window.clearInterval(timer);
  }, [callId]);

  useEffect(() => () => void teardown(false, null), [teardown]);

  const value = useMemo(() => ({ call, levels: { you: () => levels.current.you(), bot: () => levels.current.bot() }, start, end, toggleMute }), [call, start, end, toggleMute]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCall(): CallContext {
  const context = useContext(Context);
  if (!context) throw new Error("useCall needs CallProvider");
  return context;
}

/** "1:31", how long a call has run. */
export function callClock(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
