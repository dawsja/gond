"use client";

import type { SpeechModels } from "@gond/shared";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The "Something else…" item, for typing the id of a model a server of the person's own serves. */
export const TYPED_MODEL = "__typed__";
const TYPED_LABEL = "Something else…";

function ModelName({ id, isDefault }: { id: string; isDefault: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{id}</span>
      {isDefault ? <span className="shrink-0 text-muted-foreground">Default</span> : null}
    </span>
  );
}

/**
 * The models the voice key offers for one job, listed as the bots' model picker lists its own: by family
 * when there are several, the default marked. `others` are a server's own ids; `typed` adds Something else.
 */
export function SpeechModelSelect({
  id,
  models,
  others = [],
  typed = false,
  value,
  disabled = false,
  onPick,
}: {
  id: string;
  models: SpeechModels;
  others?: string[];
  typed?: boolean;
  value: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const items = [...models.groups.flatMap((group) => group.models), ...others].map((model) => ({ value: model, label: model }));
  if (typed) items.push({ value: TYPED_MODEL, label: TYPED_LABEL });
  const labelled = models.groups.length + (others.length ? 1 : 0) > 1;
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(next) => next && onPick(String(next))}>
      <SelectTrigger id={id} className="w-full max-w-sm">
        <SelectValue>{(current: string) => (current === TYPED_MODEL ? TYPED_LABEL : <ModelName id={current} isDefault={current === models.default} />)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models.groups.map((group) => (
          <SelectGroup key={group.name}>
            {labelled ? <SelectLabel>{group.name}</SelectLabel> : null}
            {group.models.map((model) => (
              <SelectItem key={model} value={model}>
                <ModelName id={model} isDefault={model === models.default} />
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {others.length ? (
          <SelectGroup>
            {labelled ? <SelectLabel>On your server</SelectLabel> : null}
            {others.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {typed ? (
          <SelectGroup>
            <SelectItem value={TYPED_MODEL}>{TYPED_LABEL}</SelectItem>
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
