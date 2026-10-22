"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";

const SEEN = "gond-version";

/**
 * Keeps every open page on the server's version: when the server comes back from an update with a new
 * one, the page reloads, and the first page opened after an update on each device says so once.
 */
export function VersionWatch() {
  const first = useRef<string | null>(null);

  const check = useCallback(async () => {
    const data = await api<{ version: string }>("/api/version").catch(() => null);
    if (!data) return;
    if (first.current === null) {
      first.current = data.version;
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(SEEN);
        localStorage.setItem(SEEN, data.version);
      } catch {
        /* storage off: nothing to compare */
      }
      if (seen && seen !== data.version && data.version !== "dev") toast.add({ title: "Gond is up to date", description: `Version ${data.version}` });
      return;
    }
    if (data.version !== first.current) window.location.reload();
  }, []);

  useEffect(() => {
    void Promise.resolve().then(check);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [check]);

  useLiveEvents((event) => {
    if (event.topic === "open") void check();
  });

  return null;
}
