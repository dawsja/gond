"use client";

import { ENGINE_LABELS, isPlanProvider, type Engine, type ModelChoice, type ModelList } from "@gond/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

const OTHER = "__other__";

function valueOf(engine: Engine, id: string) {
  return `${engine}:${id}`;
}

function TypedModel({ value, disabled, onSave, onList }: { value: string; disabled: boolean; onSave: (model: string) => void; onList: (() => void) | null }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <Input
        id="model"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onSave(draft)}
        onKeyDown={(e) => e.key === "Enter" && onSave(draft)}
        placeholder="The model id, as the engine names it"
        autoCapitalize="none"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-[13px]"
      />
      {onList ? (
        <Button type="button" variant="ghost" size="sm" className="self-start pointer-coarse:min-h-11" onClick={onList}>
          Pick from the list instead
        </Button>
      ) : null}
    </div>
  );
}

export function ModelPicker({
  engine,
  model,
  disabled = false,
  only = false,
  onChange,
}: {
  engine: Engine;
  model: string;
  disabled?: boolean;
  /** Lists only `engine`'s own models, so picking one never moves the bots to another engine. */
  only?: boolean;

  onChange: (next: { engine: Engine; model: string }) => void;
}) {
  const [list, setList] = useState<ModelList | null>(null);
  const [typing, setTyping] = useState(false);

  const load = useCallback(async () => {
    const data = await api<ModelList>("/api/models").catch(() => null);
    setList(data ?? { groups: [] });
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });

  // A plan only runs the models it lists, so an engine with none picked yet, or one left over from another
  // engine, takes the plan's own default rather than asking for an id.
  const picked = useRef<string | null>(null);
  useEffect(() => {
    const group = list?.groups.find((candidate) => candidate.engine === engine);
    if (!group?.models.length || typing || group.models.some((choice) => choice.id === model)) return;
    if (model !== "" && !isPlanProvider(ENGINE_LABELS[engine].provider)) return;
    const choice = group.models.find((candidate) => candidate.default) ?? group.models[0]!;
    if (picked.current === `${engine}:${choice.id}`) return;
    picked.current = `${engine}:${choice.id}`;
    void Promise.resolve().then(() => onChange({ engine, model: choice.id }));
  }, [list, engine, model, typing, onChange]);

  if (!list) {
    return (
      <span className="flex h-10 items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner />
        Reading the models…
      </span>
    );
  }

  const groups = list.groups.filter((group) => group.models.length && (!only || group.engine === engine));
  const known = groups.some((group) => group.engine === engine && group.models.some((choice) => choice.id === model));

  const plan = isPlanProvider(ENGINE_LABELS[engine].provider);
  const useInput = typing || (model !== "" && !known && !plan);
  const save = (next: { engine: Engine; model: string }) => {
    if (next.engine === engine && next.model.trim() === model) return;
    onChange({ engine: next.engine, model: next.model.trim() });
  };

  if (useInput) {
    return (
      <TypedModel
        key={engine}
        value={model}
        disabled={disabled}
        onSave={(id) => save({ engine, model: id })}
        onList={
          groups.length
            ? () => {
                setTyping(false);
                const first = groups[0]!;
                save({ engine: first.engine, model: first.models[0]!.id });
              }
            : null
        }
      />
    );
  }

  const label = (choice: ModelChoice) => choice.name ?? choice.id;
  const items = [
    ...groups.flatMap((group) => group.models.map((choice) => ({ value: valueOf(group.engine, choice.id), label: only ? label(choice) : `${label(choice)} · ${ENGINE_LABELS[group.engine].name}` }))),
    { value: OTHER, label: "Something else…" },
  ];
  const detail = list.groups.find((group) => group.engine === engine)?.detail ?? null;

  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Select
        items={items}
        value={valueOf(engine, model)}
        disabled={disabled}
        onValueChange={(next) => {
          if (!next) return;
          if (next === OTHER) {
            setTyping(true);
            return;
          }
          const at = String(next).indexOf(":");
          save({ engine: String(next).slice(0, at) as Engine, model: String(next).slice(at + 1) });
        }}
      >
        <SelectTrigger id="model" className="w-full max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectGroup key={group.engine}>
              {groups.length > 1 ? <SelectLabel>{ENGINE_LABELS[group.engine].name}</SelectLabel> : null}
              {group.models.map((choice) => (
                <SelectItem key={valueOf(group.engine, choice.id)} value={valueOf(group.engine, choice.id)}>
                  {label(choice)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectItem value={OTHER}>Something else…</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {detail ? <span className="text-[12px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}
