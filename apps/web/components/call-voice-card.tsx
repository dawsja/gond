"use client";

import type { CallVoice, VoiceProvider, VoiceSettings } from "@gond/shared";
import { Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LoadFailed } from "@/components/load-failed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { VoiceModelChoices } from "@/components/voice-models";
import { useVoice, useVoiceModels } from "@/hooks/use-voice";
import { api } from "@/lib/api";

type Voices = { provider: VoiceProvider | null; voices: CallVoice[]; chosen: string | null };

const nameOf = (voice: CallVoice) => (voice.detail ? `${voice.name} · ${voice.detail}` : voice.name);

async function playSample(id: string) {
  const res = await fetch(`/api/voice/sample?voice=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "There's no sample of that voice.");
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = await context.decodeAudioData(await res.arrayBuffer());
  source.connect(context.destination);
  source.onended = () => void context.close();
  source.start();
}

export function CallVoiceCard() {
  const { voice, setVoice } = useVoice();
  const { models, failed: modelsFailed, reload: reloadModels } = useVoiceModels(voice?.using);
  const [list, setList] = useState<Voices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const provider = voice?.using ?? null;
  const callModel = voice?.callModel ?? null;

  const load = useCallback(async () => {
    try {
      setList(await api<Voices>("/api/voice/voices"));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't list the voices.");
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, provider, callModel]);

  async function pickModel(id: string) {
    try {
      setVoice(await api<VoiceSettings>("/api/voice", { method: "PUT", body: JSON.stringify({ callModel: id }) }));
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't save the model." });
    }
  }

  async function pick(id: string) {
    setList((current) => (current ? { ...current, chosen: id } : current));
    try {
      await api("/api/voice/call-voice", { method: "PUT", body: JSON.stringify({ voice: id }) });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't save the voice." });
      void load();
    }
  }

  async function sample() {
    if (!list?.chosen || playing) return;
    setPlaying(true);
    try {
      await playSample(list.chosen);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't play it." });
    } finally {
      setPlaying(false);
    }
  }

  const items = (list?.voices ?? []).map((v) => ({ value: v.id, label: nameOf(v) }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Call voice</CardTitle>
        <CardDescription>What your primary bot talks on when you call it, and how it sounds.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {voice?.using === "openai" ? (
          modelsFailed && !models ? (
            <LoadFailed what="the call models" onRetry={() => void reloadModels()} />
          ) : models ? (
            <Field>
              <FieldTitle>Model</FieldTitle>
              <VoiceModelChoices name="call-model" models={models.call} value={voice.callModel} onPick={(id) => void pickModel(id)} />
            </Field>
          ) : (
            <Skeleton className="h-40 rounded-2xl" />
          )
        ) : null}
        {!voice || (!list && !error) ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : !voice.using ? (
          <p className="text-sm text-muted-foreground">Add a voice key above to call your primary bot.</p>
        ) : !list?.provider ? (
          error ? <LoadFailed what="the voices" onRetry={() => void load()} /> : null
        ) : (
          <Field>
            <FieldLabel htmlFor="call-voice">Voice</FieldLabel>
            <div className="flex max-w-sm flex-col gap-2 sm:flex-row sm:items-center">
              <Select items={items} value={list.chosen ?? undefined} onValueChange={(next) => next && void pick(String(next))}>
                <SelectTrigger id="call-voice" className="w-full sm:flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div>
                <Button type="button" variant="outline" onClick={() => void sample()} disabled={playing || !list.chosen}>
                  {playing ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" aria-hidden="true" />}
                  Hear it
                </Button>
              </div>
            </div>
          </Field>
        )}
      </CardContent>
    </Card>
  );
}
