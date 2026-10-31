"use client";

import { type ModelChoice, type ModelCurrent, type ModelList } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";

const DEFAULT = "__default__";

export type BotModels = { current: ModelCurrent; choices: ModelChoice[] };

/** The models of the engine the bots run on now; null while loading or when the list can't be read. */
export function useBotModels(): BotModels | null {
  const [models, setModels] = useState<BotModels | null>(null);
  const load = useCallback(async () => {
    const list = await api<ModelList>("/api/models").catch(() => null);
    const current = list?.current;
    setModels(current ? { current, choices: list.groups.find((group) => group.engine === current.engine)?.models ?? [] } : null);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });
  return models;
}

/**
 * The model one bot runs on, from the models the person's AI offers. Shown only when there is a choice:
 * an engine that lists one model, or none, leaves every bot on Settings → AI's.
 */
export function BotModelField({ models, value, disabled, onChange }: { models: BotModels | null; value: string; disabled?: boolean; onChange: (model: string) => void }) {
  if (!models || (models.choices.length < 2 && !value)) return null;
  const label = (choice: ModelChoice) => choice.name ?? choice.id;
  const fallback = models.choices.find((choice) => choice.id === models.current.model);
  const choices = value && !models.choices.some((choice) => choice.id === value) ? [...models.choices, { id: value }] : models.choices;
  const items = [{ value: DEFAULT, label: fallback ? `Default (${label(fallback)})` : "Default" }, ...choices.map((choice) => ({ value: choice.id, label: label(choice) }))];

  return (
    <Field>
      <FieldLabel htmlFor="bot-model">Model</FieldLabel>
      <Select items={items} value={value || DEFAULT} disabled={disabled} onValueChange={(next) => next && onChange(next === DEFAULT ? "" : String(next))}>
        <SelectTrigger id="bot-model" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={DEFAULT}>{items[0]!.label}</SelectItem>
          </SelectGroup>
          <SelectGroup>
            {choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {label(choice)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>Default follows Settings → AI. A lighter model suits quick jobs like checking email; a stronger one suits long work like coding.</FieldDescription>
    </Field>
  );
}
