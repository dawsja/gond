"use client";

import { VOICE_MODELS, VOICE_PREFERENCES, type VoicePreference, type VoiceSettings } from "@gond/shared";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useVoice } from "@/hooks/use-voice";
import { api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-sections";

function optionLabel(preference: VoicePreference) {
  return preference === "auto" ? "Automatic" : VOICE_MODELS[preference].label;
}

function usingLine(voice: VoiceSettings) {
  if (!voice.using) return "Add an xAI or OpenAI key under AI to turn on the microphone.";
  const name = `${VOICE_MODELS[voice.using].label} (${voice.using === "openai" ? voice.openaiModel : VOICE_MODELS[voice.using].model})`;
  if (voice.preference === "auto") return `Using ${name}, the cheapest of your keys.`;
  if (voice.preference !== voice.using) return `Your ${VOICE_MODELS[voice.preference].label} key is gone, so ${name} is used.`;
  return `Using ${name}.`;
}

export function VoiceCard() {
  const { voice, setVoice } = useVoice();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<string | null>(null);

  async function save(patch: { preference?: VoicePreference; openaiModel?: string }) {
    setSaving(true);
    setError(null);
    try {
      setVoice(await api<VoiceSettings>("/api/voice", { method: "PUT", body: JSON.stringify(patch) }));
      if (patch.openaiModel !== undefined) setModel(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function saveModel(event: FormEvent) {
    event.preventDefault();
    if (model !== null) void save({ openaiModel: model });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice model</CardTitle>
        <CardDescription>Talk instead of typing. What you say is turned into text in the message box, and you send it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {voice ? (
          <Field data-disabled={saving || undefined}>
            <FieldTitle id="voice-label">Turns speech into text</FieldTitle>
            <ToggleGroup aria-labelledby="voice-label" variant="pill" value={[voice.preference]} onValueChange={(next) => next[0] && void save({ preference: next[0] as VoicePreference })} disabled={saving} className="flex-wrap">
              {VOICE_PREFERENCES.map((preference) => (
                <ToggleGroupItem key={preference} value={preference} disabled={preference !== "auto" && !voice.available.includes(preference)} className="pointer-coarse:min-h-11">
                  {optionLabel(preference)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{usingLine(voice)}</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        ) : (
          <Skeleton className="h-20 rounded-xl" />
        )}
        {voice?.available.includes("openai") ? (
          <form onSubmit={saveModel}>
            <Field data-disabled={saving || undefined}>
              <FieldLabel htmlFor="voice-openai-model">OpenAI-compatible model</FieldLabel>
              <div className="flex gap-2">
                <Input id="voice-openai-model" value={model ?? voice.openaiModel} onChange={(e) => setModel(e.target.value)} placeholder={VOICE_MODELS.openai.model} autoComplete="off" spellCheck={false} disabled={saving} />
                {model !== null && model.trim() !== voice.openaiModel ? (
                  <Button type="submit" variant="outline" disabled={saving}>
                    Save
                  </Button>
                ) : null}
              </div>
              <FieldDescription>{`${VOICE_MODELS.openai.model} for OpenAI. For a server of your own, like a local Whisper, the model id it serves. Empty puts ${VOICE_MODELS.openai.model} back.`}</FieldDescription>
            </Field>
          </form>
        ) : null}
        {voice && voice.available.length < 2 ? (
          <div>
            <Button variant="outline" render={<Link href={settingsHref("ai")} />} nativeButton={false}>
              Add a key
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
