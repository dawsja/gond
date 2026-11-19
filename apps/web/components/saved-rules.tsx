"use client";

import { ruleLabel } from "@gond/shared";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { failed } from "@/components/failed";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { useSingleFlight } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/** Forgets one of a bot's saved Always allow rules: its next matching action asks again. */
export const forgetRule = (botId: string, rule: string) => api(`/api/bots/${botId}/rules`, { method: "DELETE", body: JSON.stringify({ rule }) });

/** A bot's saved rules as the Edit dialog holds them: loaded when it opens, kept current, removed on Save. */
export function useSavedRules(botId: string | null) {
  const [rules, setRules] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const load = useSingleFlight(async () => {
    if (!botId) return;
    const data = await api<{ rules: string[] }>(`/api/bots/${botId}/rules`).catch(() => null);
    setLoadFailed(!data);
    if (data) setRules(data.rules);
  });
  useEffect(() => {
    if (botId) void Promise.resolve().then(load);
  }, [botId, load]);
  // A card answered Always allow while the dialog is open adds one.
  useLiveEvents((event) => {
    if (event.topic === "approvals" && botId) void load();
  });
  const leaving = (rules ?? []).filter((rule) => removed.has(rule));
  const remove = (gone: string[]) => setRemoved((current) => new Set([...current, ...gone]));
  const save = async () => {
    if (botId) await Promise.all(leaving.map((rule) => forgetRule(botId, rule)));
  };
  return { rules, loadFailed, load, removed, remove, changed: leaving.length > 0, save };
}

export function SavedRulesField({ name, state, disabled }: { name: string; state: ReturnType<typeof useSavedRules>; disabled?: boolean }) {
  const { rules, loadFailed, load, removed, remove } = state;
  // Rules that read the same (a file changed or written in one folder) are one row.
  const rows = useMemo(() => {
    const byLabel = new Map<string, string[]>();
    for (const rule of rules ?? []) if (!removed.has(rule)) byLabel.set(ruleLabel(rule), [...(byLabel.get(ruleLabel(rule)) ?? []), rule]);
    return [...byLabel];
  }, [rules, removed]);
  if (!rules) return loadFailed ? <LoadFailed what={`what ${name} may do without asking`} onRetry={() => void load()} /> : null;
  if (!rules.length) return null;
  return (
    <Field>
      <FieldTitle id="bot-rules">Allowed without asking</FieldTitle>
      {rows.length ? (
        <ul aria-labelledby="bot-rules" className="flex flex-col gap-1">
          {rows.map(([label, list]) => (
            <li key={label} className="flex items-center gap-3 rounded-xl border px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{label}</span>
              <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} aria-label={`Stop allowing ${label} without asking`} onClick={() => remove(list)}>
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <FieldDescription>{rows.length ? `You chose Always allow on ${name}'s cards for these. Remove one and it asks again next time.` : `Once you save, ${name} asks again before each of these.`}</FieldDescription>
    </Field>
  );
}

/** Takes back an Always allow just given on a card: the rule it saved is forgotten, so the next one asks again. */
export function UndoAlways({ botId, rule, onUndone }: { botId: string; rule: string; onUndone: () => void }) {
  const [busy, setBusy] = useState(false);
  const undo = () => {
    if (busy) return;
    setBusy(true);
    forgetRule(botId, rule)
      .then(onUndone)
      .catch(failed("Couldn't undo that. Try again."))
      .finally(() => setBusy(false));
  };
  return (
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={undo}>
      {busy ? <Spinner data-icon="inline-start" /> : null}
      Undo
    </Button>
  );
}
