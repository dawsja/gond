"use client";

import { VOICE_MODELS, type VoiceSettings } from "@gond/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useVoice } from "@/hooks/use-voice";
import { api } from "@/lib/api";

function usingLine(voice: VoiceSettings) {
  if (!voice.using) return "Add a voice key above to turn on the microphone.";
  return `Using ${VOICE_MODELS[voice.using].label} (${voice.using === "openai" ? voice.openaiModel : VOICE_MODELS[voice.using].model}).`;
}

export function VoiceCard() {
  const { voice, setVoice } = useVoice();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<string | null>(null);

  async function save(patch: { openaiModel: string }) {
    setSaving(true);
    setError(null);
    try {
      setVoice(await api<VoiceSettings>("/api/voice", { method: "PUT", body: JSON.stringify(patch) }));
      setModel(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save.");
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
          <Field>
            <FieldTitle>Turns speech into text</FieldTitle>
            <FieldDescription>{usingLine(voice)}</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        ) : (
          <Skeleton className="h-20 rounded-xl" />
        )}
        {voice?.using === "openai" ? (
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
      </CardContent>
    </Card>
  );
}
