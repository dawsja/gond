"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveEvent } from "@gond/shared";

type LiveMessage = LiveEvent | { topic: "open" };

type Listener = (message: LiveMessage) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;

let lastSeen = 0;

let hiddenAt = 0;

let refusals = 0;
let watching = false;

const SILENT_MS = 60_000;

const AWAY_MS = 10_000;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) listener();
}

function dispatch(message: LiveMessage) {
  for (const listener of [...listeners]) listener(message);
}

function reconnect() {
  source?.close();
  source = null;
  setConnected(false);
  if (listeners.size > 0) connect();
}

function resume() {
  if (listeners.size === 0) return;
  if (!source || Date.now() - lastSeen > SILENT_MS / 2) reconnect();
  else dispatch({ topic: "open" });
}

function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.setInterval(() => {
    if (source && connected && Date.now() - lastSeen > SILENT_MS) reconnect();
  }, SILENT_MS / 4);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) resume();
  });
  window.addEventListener("online", () => resume());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  watch();
  const stream = new EventSource("/api/events");
  source = stream;
  stream.onopen = () => {
    lastSeen = Date.now();
    refusals = 0;
    setConnected(true);
    dispatch({ topic: "open" });
  };
  stream.addEventListener("ping", () => {
    lastSeen = Date.now();
  });
  stream.onmessage = (event: MessageEvent<string>) => {
    lastSeen = Date.now();
    try {
      dispatch(JSON.parse(event.data) as LiveEvent);
    } catch {
      // Not ours.
    }
  };
  stream.onerror = () => {
    setConnected(false);

    if (stream.readyState === EventSource.CLOSED) {
      stream.close();
      if (source === stream) source = null;
      refusals += 1;
      const wait = Math.min(60_000, 2_000 * 2 ** (refusals - 1)) * (0.75 + Math.random() / 2);
      window.setTimeout(() => {
        if (listeners.size > 0) connect();
      }, wait);
    }
  };
}

function disconnect() {
  source?.close();
  source = null;
  setConnected(false);
}

export function useLiveEvents(onMessage: Listener): boolean {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const listener: Listener = (message) => handler.current(message);
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) disconnect();
    };
  }, []);

  return useSyncExternalStore(
    (notify) => {
      connectionListeners.add(notify);
      return () => connectionListeners.delete(notify);
    },
    () => connected,
    () => false,
  );
}

export function pollInterval(live: boolean, fallbackMs: number, safetyMs = 30_000) {
  return live ? Math.max(safetyMs, fallbackMs) : fallbackMs;
}
