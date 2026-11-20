"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** The top of a list of messages loaded a page at a time: loads the page before as it scrolls into view, or on a tap. */
export function LoadEarlier({ onLoad }: { onLoad: () => Promise<boolean> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    if (loading) return;
    setLoading(true);
    void onLoad().finally(() => setLoading(false));
  }, [loading, onLoad]);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);
  return (
    <div ref={ref} className="flex justify-center">
      <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
        {loading ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  );
}
