"use client";

import type { VoiceModelList, VoiceProvider, VoiceSettings } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { api, apiShared } from "@/lib/api";

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

/** The OpenAI speech models the voice key can use, described and priced; only an OpenAI-compatible key has any. */
export function useVoiceModels(using: VoiceProvider | null | undefined) {
  const [models, setModels] = useState<VoiceModelList | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (using !== "openai") return;
    try {
      setModels(await apiShared<VoiceModelList>("/api/voice/models"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [using]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  return { models: using === "openai" ? models : null, failed, reload: load };
}
