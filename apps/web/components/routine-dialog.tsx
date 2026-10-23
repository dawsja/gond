"use client";

import type { Bot, Routine, Skill } from "@gond/shared";
import { useEffect, useState } from "react";
import { failed } from "@/components/failed";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { api, patch } from "@/lib/api";
import { describeSchedule } from "@/lib/schedule";

export const setRoutineEnabled = (routine: Routine, enabled: boolean) => patch(`/api/routines/${routine.id}`, { enabled });

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A routine as it stands. Only its bot makes, changes, runs or removes one; the person switches it on or off. */
export function RoutineDetails({ bot, routine, onClose, onChange }: { bot: Bot; routine: Routine; onClose: () => void; onChange: () => void | Promise<void> }) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!routine.skillId) return;
    void Promise.resolve().then(() =>
      api<{ skills: Skill[] }>("/api/skills")
        .then((d) => setSkill(d.skills.find((s) => s.id === routine.skillId) ?? null))
        .catch(() => undefined),
    );
  }, [routine.skillId]);

  async function toggle(on: boolean) {
    setBusy(true);
    await setRoutineEnabled(routine, on).catch(failed(on ? "Couldn't switch the routine on." : "Couldn't switch the routine off."));
    await onChange();
    setBusy(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{routine.name}</DialogTitle>
          <DialogDescription>
            {bot.name} runs this in your conversation. To change it, run it now or remove it, ask {bot.name}.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldTitle>When</FieldTitle>
            <p className="text-sm">{describeSchedule(routine.cron)}</p>
            {routine.enabled && routine.nextRunAt ? <FieldDescription>Next {when(routine.nextRunAt)}</FieldDescription> : null}
          </Field>
          {routine.skillId ? (
            <Field>
              <FieldTitle>Skill</FieldTitle>
              <p className="text-sm">{skill ? `/${skill.slug} · ${skill.name}` : "A skill that is no longer in your library"}</p>
            </Field>
          ) : null}
          <Field>
            <FieldTitle>What it does</FieldTitle>
            <p className="max-h-48 overflow-y-auto rounded-xl border bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{routine.prompt}</p>
          </Field>
          <FieldLabel htmlFor="routine-enabled">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{routine.enabled ? "On" : "Paused"}</FieldTitle>
                <FieldDescription>{routine.enabled ? "Runs on the schedule above." : "Kept, but won't run until you turn it on."}</FieldDescription>
              </FieldContent>
              <Switch id="routine-enabled" checked={routine.enabled} disabled={busy} onCheckedChange={(on) => void toggle(on)} aria-label="Routine on or off" />
            </Field>
          </FieldLabel>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
