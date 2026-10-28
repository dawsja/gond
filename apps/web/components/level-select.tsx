"use client";

import { SPACE_LEVEL_LABELS, SPACE_LEVELS, type SpaceLevel } from "@gond/shared";
import { useState } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const LEVEL_ITEMS = SPACE_LEVELS.map((value) => ({ value, label: SPACE_LEVEL_LABELS[value].label }));

/**
 * What a bot may do for someone who isn't its person, in a space.
 * Always allow is only ever chosen on purpose: picking it asks first, with `confirm` saying exactly what
 * it lets through, and nothing changes until that's confirmed. Moving off it is immediate.
 */
export function LevelSelect({ value, onChange, labelledBy, confirm }: { value: SpaceLevel; onChange: (level: SpaceLevel, confirmed: boolean) => Promise<unknown>; labelledBy: string; confirm: { title: string; description: string } }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Select
        items={LEVEL_ITEMS}
        value={value}
        onValueChange={(next) => {
          if (!next || next === value) return;
          if (next === "full") setAsking(true);
          else void onChange(next as SpaceLevel, false);
        }}
      >
        <SelectTrigger aria-labelledby={labelledBy} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {SPACE_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                <span className="flex flex-col">
                  <span>{SPACE_LEVEL_LABELS[level].label}</span>
                  <span className="text-[12px] text-muted-foreground">{SPACE_LEVEL_LABELS[level].blurb}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Confirm open={asking} onOpenChange={setAsking} title={confirm.title} description={confirm.description} action="Always allow" onConfirm={() => onChange("full", true)} />
    </>
  );
}
