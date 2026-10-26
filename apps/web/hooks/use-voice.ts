"use client";

import type { VoiceSettings } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { api } from "@/lib/api";

export function useVoice() {
  const [voice, setVoice] = useState<VoiceSettings | null>(null);
  const load = useCallback(async () => {
    const data = await api<VoiceSettings>("/api/voice").catch(() => null);
    if (data) setVoice(data);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });
  return { voice, setVoice };
}
