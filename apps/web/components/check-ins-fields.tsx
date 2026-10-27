"use client";

import { CHECK_IN_HOURS, type CheckIns } from "@gond/shared";
import { useCallback, useEffect, useState } from "react";
import { LoadFailed } from "@/components/load-failed";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

type Loaded = { checkIns: CheckIns; gmail: boolean };

const EVERY_ITEMS = CHECK_IN_HOURS.map((hours) => ({ value: String(hours), label: `Every ${hours} hours` }));
const HOUR_ITEMS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2026, 0, 1, hour)),
}));

/** The primary bot's check-ins as the Edit dialog holds them: loaded when it opens, saved with it. */
export function useCheckIns(primary: boolean) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [value, setValue] = useState<CheckIns | null>(null);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const data = await api<Loaded>("/api/check-ins");
      setLoaded(data);
      setValue(data.checkIns);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (primary) void Promise.resolve().then(load);
  }, [primary, load]);
  const changed = Boolean(loaded && value && JSON.stringify(loaded.checkIns) !== JSON.stringify(value));
  const set = <K extends keyof CheckIns>(key: K, next: CheckIns[K]) => setValue((v) => (v ? { ...v, [key]: next } : v));
  const save = () => api<Loaded>("/api/check-ins", { method: "PUT", body: JSON.stringify(value) });
  return { primary, loaded, failed, load, value, set, changed, save };
}

export function CheckInsFields({ name, state }: { name: string; state: ReturnType<typeof useCheckIns> }) {
  const { loaded, failed, load, value, set } = state;
  if (failed) return <LoadFailed what="check-ins" onRetry={() => void load()} />;
  if (!loaded || !value) return null;
  const off = !value.enabled;
  return (
    <FieldSet>
      <FieldLegend>Check-ins</FieldLegend>
      <FieldDescription>
        {name} looks over {loaded.gmail && value.email ? "your bots, anything left unfinished and your email" : "your bots and anything left unfinished"}, and messages you only when something needs you.
      </FieldDescription>
      <FieldGroup className="gap-4">
        <Field orientation="horizontal">
          <FieldLabel htmlFor="check-ins-on" className="flex-1">
            Check in on me
          </FieldLabel>
          <Switch id="check-ins-on" checked={value.enabled} onCheckedChange={(on) => set("enabled", on)} />
        </Field>
        <Field data-disabled={off || undefined}>
          <FieldLabel htmlFor="check-ins-every">How often</FieldLabel>
          <Select items={EVERY_ITEMS} value={String(value.everyHours)} onValueChange={(next) => next && set("everyHours", Number(next) as CheckIns["everyHours"])} disabled={off}>
            <SelectTrigger id="check-ins-every" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {EVERY_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field data-disabled={off || undefined}>
          <FieldLabel htmlFor="check-ins-quiet-from">Quiet hours</FieldLabel>
          <div className="flex items-center gap-2.5">
            <HourSelect id="check-ins-quiet-from" label="Quiet from" value={value.quietFrom} disabled={off} onChange={(hour) => set("quietFrom", hour)} />
            <span className="text-sm text-muted-foreground">to</span>
            <HourSelect id="check-ins-quiet-to" label="Quiet until" value={value.quietTo} disabled={off} onChange={(hour) => set("quietTo", hour)} />
          </div>
        </Field>
        {loaded.gmail ? (
          <Field orientation="horizontal" data-disabled={off || undefined}>
            <FieldContent className="flex-1">
              <FieldLabel htmlFor="check-ins-email">Look at my email</FieldLabel>
              <FieldDescription>Only who it&apos;s from, the subject and the first lines.</FieldDescription>
            </FieldContent>
            <Switch id="check-ins-email" checked={value.email} disabled={off} onCheckedChange={(on) => set("email", on)} />
          </Field>
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}

function HourSelect({ id, label, value, disabled, onChange }: { id: string; label: string; value: number; disabled: boolean; onChange: (hour: number) => void }) {
  return (
    <Select items={HOUR_ITEMS} value={String(value)} onValueChange={(next) => next !== null && onChange(Number(next))} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="min-w-0 flex-1">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {HOUR_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
