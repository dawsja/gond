"use client";

import { VOICE_PRICES_AS_OF, type VoiceModel } from "@gond/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

// The dates are days, kept as UTC midnight, so they read the same in every time zone.
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Row({ id, value, index, disabled, children }: { id: string; value: string; index: number; disabled: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-3 p-3 pl-4", index > 0 && "border-t")}>
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5" />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children}
      </label>
    </div>
  );
}

/**
 * OpenAI's models for one job, each with what it's for and its price, the recommended one marked.
 * `others` are a server's own ids, offered bare; `extra` is one more row, like typing an id.
 */
export function VoiceModelChoices({
  name,
  models,
  others = [],
  value,
  disabled = false,
  onPick,
  extra,
}: {
  name: string;
  models: VoiceModel[];
  others?: string[];
  value: string | null;
  disabled?: boolean;
  onPick: (id: string) => void;
  extra?: { value: string; label: string; detail: string };
}) {
  const rows = models.length + others.length;
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup aria-label={name} value={value} onValueChange={(next) => typeof next === "string" && onPick(next)} className="gap-0 overflow-hidden rounded-2xl border">
        {models.map((model, index) => (
          <Row key={model.id} id={`${name}-${model.id}`} value={model.id} index={index} disabled={disabled}>
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[14px] font-medium">{model.name}</span>
              {model.recommended ? <Badge tone="ok">Recommended</Badge> : null}
              {model.retires ? <Badge tone="warn">Retires {day(model.retires)}</Badge> : null}
            </span>
            <span className="text-[12.5px] text-muted-foreground">{model.about}</span>
            <span className="text-[12.5px] font-medium">{model.price}</span>
          </Row>
        ))}
        {others.map((id, index) => (
          <Row key={id} id={`${name}-${id}`} value={id} index={models.length + index} disabled={disabled}>
            <code className="truncate font-mono text-[13px]">{id}</code>
            <span className="text-[12.5px] text-muted-foreground">On your server</span>
          </Row>
        ))}
        {extra ? (
          <Row id={`${name}-${extra.value}`} value={extra.value} index={rows} disabled={disabled}>
            <span className="text-[14px] font-medium">{extra.label}</span>
            <span className="text-[12.5px] text-muted-foreground">{extra.detail}</span>
          </Row>
        ) : null}
      </RadioGroup>
      {models.length ? <p className="text-[12.5px] text-muted-foreground">{`OpenAI's list prices on ${day(VOICE_PRICES_AS_OF)}, paid to OpenAI on your key.`}</p> : null}
    </div>
  );
}
