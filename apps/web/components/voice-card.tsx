"use client";

import type { VoiceSettings } from "@gond/shared";
import { useState, type FormEvent } from "react";
import { LoadFailed } from "@/components/load-failed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SpeechModelSelect, TYPED_MODEL } from "@/components/voice-models";
import { useVoice, useVoiceModels } from "@/hooks/use-voice";
import { api } from "@/lib/api";

export function VoiceCard() {
  const { voice, setVoice } = useVoice();
  const { models, setModels, failed, reload } = useVoiceModels(voice?.using);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [model, setModel] = useState<string | null>(null);

  /** An empty pick, or the default's own id, follows each newer model the key offers. */
  async function save(pick: string) {
    setSaving(true);
    setError(null);
    try {
      setVoice(await api<VoiceSettings>("/api/voice", { method: "PUT", body: JSON.stringify({ transcribeModel: pick }) }));
      setModels((current) => (current ? { ...current, transcribe: { ...current.transcribe, chosen: pick || current.transcribe.default } } : current));
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
    if (model !== null) void save(model.trim());
  }

  const chosen = models?.transcribe.chosen ?? "";
  const listed = models ? [...models.transcribe.groups.flatMap((group) => group.models), ...models.others] : [];
  const showTyped = Boolean(models?.own && (typing || !listed.includes(chosen)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice model</CardTitle>
        <CardDescription>Talk instead of typing. What you say is turned into text in the message box, and you send it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!voice ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : !voice.using ? (
          <Field>
            <FieldTitle>Turns speech into text</FieldTitle>
            <FieldDescription>Add a voice key above to turn on the microphone.</FieldDescription>
          </Field>
        ) : failed && !models ? (
          <LoadFailed what="the models" onRetry={() => void reload()} />
        ) : !models ? (
          <Skeleton className="h-16 max-w-sm rounded-xl" />
        ) : (
          <Field data-disabled={saving || undefined}>
            <FieldLabel htmlFor="transcribe-model">Turns speech into text</FieldLabel>
            <SpeechModelSelect
              id="transcribe-model"
              models={models.transcribe}
              others={models.others}
              typed={models.own}
              value={showTyped ? TYPED_MODEL : chosen}
              disabled={saving}
              onPick={(id) => {
                if (id === TYPED_MODEL) setTyping(true);
                else void save(id === models.transcribe.default ? "" : id);
              }}
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        )}
        {showTyped && models ? (
          <form onSubmit={saveTyped}>
            <Field data-disabled={saving || undefined}>
              <FieldLabel htmlFor="voice-model-id">Model id</FieldLabel>
              <div className="flex max-w-sm gap-2">
                <Input
                  id="voice-model-id"
                  value={model ?? (listed.includes(chosen) ? "" : chosen)}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={models.transcribe.default}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                />
                {model !== null && model.trim() !== chosen ? (
                  <Button type="submit" variant="outline" disabled={saving}>
                    Save
                  </Button>
                ) : null}
              </div>
              <FieldDescription>{`The model id your server serves. Empty puts ${models.transcribe.default} back.`}</FieldDescription>
            </Field>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
