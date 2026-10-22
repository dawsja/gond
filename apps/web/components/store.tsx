"use client";

import type { Approval, Bot, BoxUpdate, DesktopState, Me, Thread } from "@gond/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { api } from "@/lib/api";
import { applyAccent } from "@/lib/theme/theme";

export type ThreadRow = Thread & { busy?: boolean };

export type { Me };

type Store = {
  bots: Bot[];
  threads: ThreadRow[];
  approvals: Approval[];

  activity: Record<string, Record<string, string>>;

  me: Me;
  setMe: (me: Me) => void;

  admin: boolean;

  boxUpdate: BoxUpdate | null;
  boxUpdating: boolean;
  desktop: DesktopState | null;
  loaded: boolean;
  live: boolean;
  refresh: () => Promise<void>;
  botById: (id: string) => Bot | undefined;
};

const StoreContext = createContext<Store | null>(null);
const POLL_MS = 15_000;

const UPDATING = new Set(["pausing", "pulling", "restarting", "patching", "resuming"]);

export function StoreProvider({ user, children }: { user: Me; children: ReactNode }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Record<string, Record<string, string>>>({});
  const [me, setMe] = useState<Me>(user);
  const [boxUpdate, setBoxUpdate] = useState<BoxUpdate | null>(null);
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadMe = useCallback(async () => {
    const data = await api<{ user: Me }>("/api/me");
    setMe(data.user);
  }, []);
  const loadBoxUpdate = useCallback(async () => {
    const data = await api<{ update: BoxUpdate }>("/api/box/update");
    setBoxUpdate(data.update.phase === "idle" ? null : data.update);
  }, []);
  const loadDesktop = useCallback(async () => {
    const data = await api<{ desktop: DesktopState | null }>("/api/box/desktop").catch(() => null);
    if (data?.desktop) setDesktop(data.desktop);
  }, []);

  const loadBots = useCallback(async () => {
    const [b, t] = await Promise.all([api<{ bots: Bot[] }>("/api/bots"), api<{ threads: ThreadRow[] }>("/api/threads")]);
    setBots(b.bots);
    setThreads(t.threads);

    const idle = new Set(t.threads.filter((row) => row.busy === false).map((row) => row.id));
    setActivity((current) => (Object.keys(current).some((id) => idle.has(id)) ? Object.fromEntries(Object.entries(current).filter(([id]) => !idle.has(id))) : current));
  }, []);
  const loadApprovals = useCallback(async () => {
    const a = await api<{ approvals: Approval[] }>("/api/approvals?status=pending");
    setApprovals(a.approvals);
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([loadBots(), loadApprovals(), loadBoxUpdate().catch(() => undefined), loadDesktop()]).catch(() => undefined);
    setLoaded(true);
  }, [loadBots, loadApprovals, loadBoxUpdate, loadDesktop]);

  useEffect(() => {
    applyAccent(me.accent);
  }, [me.accent]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const live = useLiveEvents((message) => {
    if (message.topic === "open") void refreshRef.current();
    else if (message.topic === "bots" || message.topic === "thread") void loadBots().catch(() => undefined);
    else if (message.topic === "approvals") void loadApprovals().catch(() => undefined);
    else if (message.topic === "me") void loadMe().catch(() => undefined);
    else if (message.topic === "box") void loadBoxUpdate().catch(() => undefined);
    else if (message.topic === "desktop") setDesktop(message.desktop);
    else if (message.topic === "activity") {
      setActivity((current) => {
        const forThread = { ...(current[message.threadId] ?? {}) };
        if (message.line === null) delete forThread[message.botId];
        else forThread[message.botId] = message.line;
        return { ...current, [message.threadId]: forThread };
      });
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => void refreshRef.current(), pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live]);

  const value = useMemo<Store>(
    () => ({ bots, threads, approvals, activity, me, setMe, admin: me.role === "admin", boxUpdate, boxUpdating: Boolean(boxUpdate && UPDATING.has(boxUpdate.phase)), desktop, loaded, live, refresh, botById: (id) => bots.find((b) => b.id === id) }),
    [bots, threads, approvals, activity, me, boxUpdate, desktop, loaded, live, refresh],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore needs StoreProvider");
  return store;
}
