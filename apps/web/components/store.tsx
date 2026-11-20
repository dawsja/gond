"use client";

import type { Approval, Bot, BoxUpdate, DesktopState, Me, Profile, Thread } from "@gond/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { singleFlight } from "@/lib/single-flight";
import { api, post } from "@/lib/api";
import { keep } from "@/lib/keep";
import { applyAccent } from "@/lib/theme/theme";

export type ThreadRow = Thread & { busy?: boolean };


type Store = {
  bots: Bot[];
  threads: ThreadRow[];
  approvals: Approval[];
  me: Me;
  setMe: (me: Me) => void;
  /** Every profile of the person's, the open one included (`me.profile`). */
  profiles: Profile[];

  admin: boolean;

  boxUpdate: BoxUpdate | null;
  boxUpdating: boolean;
  desktop: DesktopState | null;
  loaded: boolean;
  live: boolean;
  refresh: () => Promise<void>;
  botById: (id: string) => Bot | undefined;
};

type Activity = Record<string, Record<string, string>>;

const StoreContext = createContext<Store | null>(null);
// Tool lines change many times a turn; only what shows them listens.
const ActivityContext = createContext<Activity>({});
const POLL_MS = 15_000;
// A reply's thread and bots events, and the read marker's bots event a moment later, make one reload,
// held back at most so long that the list never lags far behind.
const LISTS_QUIET_MS = 350;
const LISTS_MAX_WAIT_MS = 1_000;

const UPDATING = new Set(["pausing", "pulling", "restarting", "patching", "resuming"]);

export function StoreProvider({ user, children }: { user: Me; children: ReactNode }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Activity>({});
  const [me, setMe] = useState<Me>(user);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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

  // This device moved to another profile (another tab switched, or the open one was deleted): everything
  // on the page is the old profile's while requests already reach the new one, so start over in it.
  const loadProfilesNow = useCallback(async () => {
    const data = await api<{ profiles: Profile[]; active: string }>("/api/profiles");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (data.active !== user.profile.id) return window.location.assign("/app");
    setProfiles(data.profiles);
  }, [user.profile.id]);
  const loadProfiles = useMemo(() => singleFlight(loadProfilesNow), [loadProfilesNow]);

  const loadBotsNow = useCallback(async () => {
    const [b, t] = await Promise.all([api<{ bots: Bot[] }>("/api/bots"), api<{ threads: ThreadRow[] }>("/api/threads")]);
    setBots((current) => keep(current, b.bots));
    setThreads((current) => keep(current, t.threads));

    const idle = new Set(t.threads.filter((row) => row.busy === false).map((row) => row.id));
    setActivity((current) => (Object.keys(current).some((id) => idle.has(id)) ? Object.fromEntries(Object.entries(current).filter(([id]) => !idle.has(id))) : current));
  }, []);
  const loadBots = useMemo(() => singleFlight(loadBotsNow), [loadBotsNow]);
  const loadApprovals = useCallback(async () => {
    const a = await api<{ approvals: Approval[] }>("/api/approvals?status=pending");
    setApprovals((current) => keep(current, a.approvals));
  }, []);
  // The chat list shows once bots and conversations are in; the computer's state and the rest follow on their own.
  const refresh = useCallback(async () => {
    const lists = loadBots()
      .catch(() => undefined)
      .then(() => setLoaded(true));
    await Promise.all([lists, loadApprovals(), loadBoxUpdate(), loadDesktop(), loadProfiles()].map((load) => load.catch(() => undefined)));
  }, [loadBots, loadApprovals, loadBoxUpdate, loadDesktop, loadProfiles]);

  // A notice from another profile opens with `?profile=`: open that profile here first.
  useEffect(() => {
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get("profile");
    if (!wanted) return;
    url.searchParams.delete("profile");
    const clean = `${url.pathname}${url.search}${url.hash}`;
    if (wanted === user.profile.id) return window.history.replaceState(window.history.state, "", clean);
    void post(`/api/profiles/${encodeURIComponent(wanted)}/open`)
      .then(() => window.location.replace(clean))
      .catch(() => window.history.replaceState(window.history.state, "", clean));
  }, [user.profile.id]);

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

  const listsTimer = useRef<number | null>(null);
  const listsAskedAt = useRef(0);
  const loadBotsSoon = () => {
    const now = Date.now();
    if (listsTimer.current === null) listsAskedAt.current = now;
    else window.clearTimeout(listsTimer.current);
    const wait = Math.min(LISTS_QUIET_MS, Math.max(0, listsAskedAt.current + LISTS_MAX_WAIT_MS - now));
    listsTimer.current = window.setTimeout(() => {
      listsTimer.current = null;
      void loadBots().catch(() => undefined);
    }, wait);
  };
  useEffect(
    () => () => {
      if (listsTimer.current !== null) window.clearTimeout(listsTimer.current);
    },
    [],
  );

  const live = useLiveEvents((message) => {
    if (message.topic === "open" && message.first) {
      loadBotsSoon();
      void loadApprovals().catch(() => undefined);
    } else if (message.topic === "open") void refreshRef.current();
    else if (message.topic === "bots" || message.topic === "thread") loadBotsSoon();
    else if (message.topic === "approvals") void loadApprovals().catch(() => undefined);
    else if (message.topic === "me") void loadMe().catch(() => undefined);
    else if (message.topic === "profiles") void loadProfiles().catch(() => undefined);
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
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshRef.current();
    }, pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live]);

  const value = useMemo<Store>(
    () => ({ bots, threads, approvals, me, setMe, profiles, admin: me.role === "admin", boxUpdate, boxUpdating: Boolean(boxUpdate && UPDATING.has(boxUpdate.phase)), desktop, loaded, live, refresh, botById: (id) => bots.find((b) => b.id === id) }),
    [bots, threads, approvals, me, profiles, boxUpdate, desktop, loaded, live, refresh],
  );
  return (
    <StoreContext.Provider value={value}>
      <ActivityContext.Provider value={activity}>{children}</ActivityContext.Provider>
    </StoreContext.Provider>
  );
}

/** What each bot is doing, per conversation: `activity[threadId][botId]` is its line. */
export function useActivity(): Activity {
  return useContext(ActivityContext);
}

/** `singleFlight` over the latest `run`, with one identity for the component's life. */
export function useSingleFlight(run: () => Promise<void>): () => Promise<void> {
  const latest = useStableCallback(run);
  return useMemo(() => singleFlight(latest), [latest]);
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore needs StoreProvider");
  return store;
}
