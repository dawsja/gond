"use client";

import { CALL_SAMPLE_RATE, type CallEvent, type CallInfo } from "@gond/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { api, del, post } from "@/lib/api";
import { CallPlayer, levelOf, MicError, startCapture, type Capture } from "@/lib/call-audio";

export type CallPhase = "connecting" | "live";

export type CallView = {
  info: CallInfo;
  phase: CallPhase;
  muted: boolean;
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
  /** The call's socket; null once it fell back to the stream and POSTs. */
  socket: WebSocket | null;
  source: EventSource | null;
  queue: ArrayBuffer[];
  sending: boolean;
  closed: boolean;
  muted: boolean;
};

// Without the socket, a tenth of a second per request at least, as before it: a POST every 20 ms is too many.
const POST_BATCH_BYTES = (CALL_SAMPLE_RATE / 10) * 2;

function queued(current: Live): number {
  return current.queue.reduce((total, part) => total + part.byteLength, 0);
}

/**
 * The microphone goes up in order: on the socket as each chunk comes, or, where the socket couldn't
 * open, one request at a time with whatever piled up while the last was out.
 */
async function flush(current: Live) {
  if (current.socket) {
    if (current.socket.readyState !== WebSocket.OPEN) return;
    for (const part of current.queue.splice(0)) current.socket.send(part);
    return;
  }
  if (current.sending || !current.source) return;
  current.sending = true;
  while (!current.closed && queued(current) >= POST_BATCH_BYTES) {
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

  const teardown = useCallback(async (drain: boolean, reason: string | { title: string; description: string | null } | null) => {
    const current = live.current;
    if (!current || current.closed) return;
    current.closed = true;
    live.current = null;
    current.socket?.close();
    current.source?.close();
    current.capture?.stop();
    levels.current = SILENT;
    setCall(null);
    if (drain) await current.player.drained(DRAIN_MS);
    void current.context.close().catch(() => undefined);
    if (typeof reason === "string") toast.add({ type: "error", title: reason });
    else if (reason) toast.add({ type: "error", title: reason.title, description: reason.description ?? undefined });
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
        case "ended":
          void teardown(true, event.reason);
          return;
      }
    },
    [teardown],
  );

  const start = useCallback(
    async (threadId: string) => {
      // Made inside the tap, before anything is awaited, or Safari keeps it silent.
      const context = new AudioContext();
      if (live.current) await teardown(false, null);
      let info: CallInfo;
      try {
        info = (await post<{ call: CallInfo }>(`/api/threads/${threadId}/call`)).call;
      } catch (failure) {
        void context.close();
        toast.add({ type: "error", title: failure instanceof Error ? failure.message : "The call couldn't start." });
        return;
      }
      const current: Live = { info, context, player: new CallPlayer(context), capture: null, socket: null, source: null, queue: [], sending: false, closed: false, muted: false };
      live.current = current;
      setCall({ info, phase: "connecting", muted: false, speaking: false });

      const read = (data: string) => {
        try {
          onEvent(current, JSON.parse(data) as CallEvent);
        } catch {
          /* not an event */
        }
      };
      // The SSE stream and a POST per batch of audio, for when something between the page and Gond
      // won't carry a WebSocket.
      const fallBack = () => {
        current.socket = null;
        const source = new EventSource(`/api/calls/${info.id}/stream`);
        current.source = source;
        source.onmessage = (message) => read(message.data as string);
        source.onerror = () => {
          if (source.readyState === EventSource.CLOSED) void teardown(false, "The call dropped.");
        };
        if (current.muted) void api(`/api/calls/${info.id}/mute`, { method: "POST", body: JSON.stringify({ muted: true }) }).catch(() => undefined);
        void flush(current);
      };
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/calls/${info.id}/socket`);
      socket.binaryType = "arraybuffer";
      current.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        if (current.muted) socket.send(JSON.stringify({ type: "mute", muted: true }));
        void flush(current);
      };
      socket.onmessage = (message: MessageEvent<string | ArrayBuffer>) => {
        if (typeof message.data === "string") read(message.data);
        else current.player.playPcm(message.data);
      };
      socket.onclose = () => {
        if (current.closed || current.socket !== socket) return;
        if (opened) void teardown(false, "The call dropped.");
        else fallBack();
      };

      try {
        current.capture = await startCapture(context, (pcm) => {
          current.queue.push(pcm);
          void flush(current);
        });
      } catch (failure) {
        void del(`/api/calls/${info.id}`).catch(() => undefined);
        const mic = failure instanceof MicError ? failure : new MicError("The microphone didn't start.");
        void teardown(false, { title: mic.message, description: mic.detail });
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
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: "mute", muted }));
    else if (current.source) void api(`/api/calls/${current.info.id}/mute`, { method: "POST", body: JSON.stringify({ muted }) }).catch(() => undefined);
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
