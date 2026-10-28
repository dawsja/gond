"use client";

import type { Teaching, TeachStatus } from "@gond/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { api, apiShared } from "@/lib/api";

/** Where showing a bot how is still the person's or the bot's to finish: one at a time. */
const OPEN_STATUSES: TeachStatus[] = ["recording", "paused", "review", "looking"];

type TeachingState = {
  open: Teaching | null;
  byId: Record<string, Teaching>;
  /** When each teaching last arrived, for the recording clock to count on from. */
  seenAt: Record<string, number>;
  put: (teaching: Teaching) => void;
};

const TeachingContext = createContext<TeachingState | null>(null);

/**
 * Showing a bot how, apart from the store: a recording's steps arrive several times a second,
 * and only what shows them should redraw. Holds the person's open recording and every card's
 * teaching by id, each replaced as its live event arrives.
 */
export function TeachingProvider({ children }: { children: ReactNode }) {
  const [byId, setById] = useState<Record<string, Teaching>>({});
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const put = useCallback((teaching: Teaching) => {
    setById((current) => ({ ...current, [teaching.id]: teaching }));
    setSeenAt((current) => ({ ...current, [teaching.id]: Date.now() }));
    setOpenId((current) => (OPEN_STATUSES.includes(teaching.status) ? teaching.id : current === teaching.id ? null : current));
  }, []);

  const loadOpen = useCallback(async () => {
    const data = await api<{ teaching: Teaching | null }>("/api/teachings/open").catch(() => null);
    if (!data) return;
    if (data.teaching) put(data.teaching);
    else setOpenId(null);
  }, [put]);

  useEffect(() => {
    void Promise.resolve().then(loadOpen);
  }, [loadOpen]);

  useLiveEvents((message) => {
    if (message.topic === "open") void loadOpen();
    else if (message.topic === "teaching") put(message.teaching);
  });

  const value = useMemo<TeachingState>(() => ({ open: openId ? (byId[openId] ?? null) : null, byId, seenAt, put }), [openId, byId, seenAt, put]);
  return <TeachingContext.Provider value={value}>{children}</TeachingContext.Provider>;
}

function useTeachingState(): TeachingState {
  const state = useContext(TeachingContext);
  if (!state) throw new Error("useTeaching needs TeachingProvider");
  return state;
}

/** The person's recording still under way or being looked at, if any. */
export function useOpenTeaching(): Teaching | null {
  return useTeachingState().open;
}

export function usePutTeaching(): (teaching: Teaching) => void {
  return useTeachingState().put;
}

/** One card's teaching: loaded once, then kept current by its live events. */
export function useTeaching(id: string | null): { teaching: Teaching | null; failed: boolean; reload: () => void } {
  const { byId, put } = useTeachingState();
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    if (!id) return;
    apiShared<{ teaching: Teaching }>(`/api/teachings/${id}`)
      .then((data) => {
        put(data.teaching);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [id, put]);
  const known = id ? (byId[id] ?? null) : null;
  useEffect(() => {
    if (id && !known) void Promise.resolve().then(reload);
  }, [id, known, reload]);
  return { teaching: known, failed, reload };
}

const noTick = () => () => undefined;

/** A recording's time so far, counting on between its events while it records. */
export function useRecordingMs(teaching: Teaching | null): number {
  const { seenAt } = useTeachingState();
  const running = teaching?.status === "recording";
  const subscribe = useCallback(
    (tick: () => void) => {
      if (!running) return () => undefined;
      const timer = window.setInterval(tick, 1000);
      return () => window.clearInterval(timer);
    },
    [running],
  );
  const now = useSyncExternalStore(running ? subscribe : noTick, () => (running ? Math.floor(Date.now() / 1000) : 0), () => 0);
  if (!teaching) return 0;
  const since = running && now ? Math.max(0, now * 1000 - (seenAt[teaching.id] ?? now * 1000)) : 0;
  return Math.min(teaching.maxMs, teaching.activeMs + since);
}

export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
