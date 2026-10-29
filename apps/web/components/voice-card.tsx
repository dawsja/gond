"use client";

import { VOICE_MODELS, type VoiceSettings } from "@gond/shared";
import { useState, type FormEvent } from "react";
import { LoadFailed } from "@/components/load-failed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { VoiceModelChoices } from "@/components/voice-models";
import { useVoice, useVoiceModels } from "@/hooks/use-voice";
import { api } from "@/lib/api";

const TYPED = "__typed__";

function usingLine(voice: VoiceSettings) {
  if (!voice.using) return "Add a voice key above to turn on the microphone.";
  return `Using ${VOICE_MODELS[voice.using].label} (${voice.using === "openai" ? voice.openaiModel : VOICE_MODELS[voice.using].model}).`;
}

export function VoiceCard() {
  const { voice, setVoice } = useVoice();
  const { models, failed, reload } = useVoiceModels(voice?.using);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [model, setModel] = useState<string | null>(null);

  async function save(openaiModel: string) {
    setSaving(true);
    setError(null);
    try {
      setVoice(await api<VoiceSettings>("/api/voice", { method: "PUT", body: JSON.stringify({ openaiModel }) }));
      setModel(null);
      setTyping(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the model.");
    } finally {
      setSaving(false);
    }
  }

  function saveTyped(event: FormEvent) {
    event.preventDefault();
    if (model !== null) void save(model);
  }

  const listed = models ? [...models.transcribe.map((m) => m.id), ...models.others] : [];
  const showTyped = Boolean(voice && models && (typing || !listed.includes(voice.openaiModel)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice model</CardTitle>
        <CardDescription>Talk instead of typing. What you say is turned into text in the message box, and you send it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!voice ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : voice.using !== "openai" ? (
          <Field>
            <FieldTitle>Turns speech into text</FieldTitle>
            <FieldDescription>{usingLine(voice)}</FieldDescription>
          </Field>
        ) : failed && !models ? (
          <LoadFailed what="the models" onRetry={() => void reload()} />
        ) : !models ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (
          <Field data-disabled={saving || undefined}>
            <FieldTitle>Turns speech into text</FieldTitle>
            <VoiceModelChoices
              name="transcribe-model"
              models={models.transcribe}
              others={models.others}
              value={showTyped ? TYPED : voice.openaiModel}
              disabled={saving}
              onPick={(id) => {
                if (id === TYPED) setTyping(true);
                else void save(id);
              }}
              extra={{ value: TYPED, label: "Another model id", detail: "For a server of your own, like a local Whisper." }}
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        )}
        {showTyped && voice ? (
          <form onSubmit={saveTyped}>
            <Field data-disabled={saving || undefined}>
              <FieldLabel htmlFor="voice-openai-model">Model id</FieldLabel>
              <div className="flex gap-2">
                <Input id="voice-openai-model" value={model ?? voice.openaiModel} onChange={(e) => setModel(e.target.value)} placeholder={VOICE_MODELS.openai.model} autoComplete="off" spellCheck={false} disabled={saving} />
                {model !== null && model.trim() !== voice.openaiModel ? (
                  <Button type="submit" variant="outline" disabled={saving}>
                    Save
                  </Button>
                ) : null}
              </div>
              <FieldDescription>{`The model id your server serves. Empty puts ${VOICE_MODELS.openai.model} back.`}</FieldDescription>
            </Field>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
