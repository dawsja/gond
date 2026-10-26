"use client";

import type { Federation, FederationPeer } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { apiShared } from "@/lib/api";

type Loaded = { federation: Federation; peers: FederationPeer[] };

/** This Gond among other Gonds, kept current by the `spaces` live event; null until it loads. */
export function useFederation(): { federation: Federation | null; peers: FederationPeer[]; failed: boolean; reload: () => void; set: (loaded: Loaded) => void } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    apiShared<Loaded>("/api/spaces/federation")
      .then((data) => {
        setLoaded(data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);
  useLiveEvents((event) => {
    if (event.topic === "spaces" || event.topic === "open") reload();
  });
  return { federation: loaded?.federation ?? null, peers: loaded?.peers ?? [], failed, reload, set: setLoaded };
}
