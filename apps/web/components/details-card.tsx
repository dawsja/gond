"use client";

import { DETAIL_KIND_LABELS, DETAIL_KINDS, DETAIL_LIMITS, DETAIL_PRESETS, daysBetween, type DetailKind, type DetailRecord } from "@gond/shared";
import { BookUser, Car, HeartPulse, IdCard, Lock, LockOpen, Pencil, Plus, Trash2, UserRound, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { useDiscardChanges } from "@/components/discard-changes";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useHeld } from "@/hooks/use-held";
import { api, del, post } from "@/lib/api";

const KIND_ICONS: Record<DetailKind, LucideIcon> = { person: UserRound, document: IdCard, insurance: HeartPulse, vehicle: Car, other: BookUser };
const KIND_ITEMS = DETAIL_KINDS.map((kind) => ({ value: kind, label: DETAIL_KIND_LABELS[kind] }));
// A reminder comes 90 days ahead; inside a month, the list says so too.
const SOON_DAYS = 30;

type Row = { key: string; id?: string; label: string; value: string; private: boolean; saved: boolean };
type Form = { kind: DetailKind; label: string; expiresOn: string; rows: Row[] };

let rowKeys = 0;
const rowKey = () => `row-${(rowKeys += 1)}`;

function presetRows(kind: DetailKind): Row[] {
  return DETAIL_PRESETS[kind].map((field) => ({ key: rowKey(), label: field.label, value: "", private: field.private, saved: false }));
}

function formOf(record: DetailRecord | null, kind: DetailKind = "person"): Form {
  if (!record) return { kind, label: "", expiresOn: "", rows: presetRows(kind) };
  return {
    kind: record.kind,
    label: record.label,
    expiresOn: record.expiresOn ?? "",
    rows: record.fields.map((field) => ({ key: rowKey(), id: field.id, label: field.label, value: field.value ?? "", private: field.private, saved: field.saved })),
  };
}

/** Today where the browser is, as YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dayText(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A record's expiry as the list shows it: plain while it's far off, a warning inside a month, and once it has run out. */
function Expiry({ day }: { day: string }) {
  const left = daysBetween(today(), day);
  if (left < 0) return <Badge tone="bad">Expired {dayText(day)}</Badge>;
  if (left <= SOON_DAYS) return <Badge tone="warn">Expires {dayText(day)}</Badge>;
  return <span>Expires {dayText(day)}</span>;
}

/** One record's details, new or changed; a private one is never shown, and stays as it is while left empty. */
function DetailDialog({ record, onClose, onSaved }: { record: DetailRecord | null; onClose: () => void; onSaved: () => void }) {
  const [initial] = useState<Form>(() => formOf(record));
  const [start] = useState(() => JSON.stringify(initial));
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== start;
  const discard = useDiscardChanges(dirty && !busy, onClose);
  const touched = form.rows.some((row) => row.value) || form.label;

  const setRow = (key: string, change: Partial<Row>) => setForm((current) => ({ ...current, rows: current.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));

  function pickKind(kind: DetailKind) {
    // A new record's fields follow its kind until anything is typed into them.
    setForm((current) => ({ ...current, kind, rows: record || current.rows.some((row) => row.value) ? current.rows : presetRows(kind) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = {
      kind: form.kind,
      label: form.label,
      expiresOn: form.expiresOn || null,
      fields: form.rows.map((row) => ({ ...(row.id ? { id: row.id } : {}), label: row.label, private: row.private, value: row.value })),
    };
    try {
      if (record) await api(`/api/details/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(body) });
      else await post("/api/details", body);
      toast.add({ type: "success", title: `Saved ${form.label.trim()}.` });
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save those details.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && discard.requestClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{record ? `Edit ${record.label}` : "Add details"}</DialogTitle>
          <DialogDescription>Your bots use these to fill in forms. A private detail is typed in for you, only after you say yes, and is never shown again, not even to your bots.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="contents">
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="detail-kind">What it is</FieldLabel>
                <Select items={KIND_ITEMS} value={form.kind} onValueChange={(value) => value && pickKind(value as DetailKind)}>
                  <SelectTrigger id="detail-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DETAIL_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {DETAIL_KIND_LABELS[kind]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="detail-label">Name</FieldLabel>
                <Input id="detail-label" value={form.label} maxLength={DETAIL_LIMITS.label} placeholder={form.kind === "person" ? "Maya" : form.kind === "document" ? "Maya's passport" : form.kind === "insurance" ? "Health insurance" : form.kind === "vehicle" ? "The car" : "School"} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
              </Field>
            </div>
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Details</FieldLegend>
              <ul className="flex flex-col gap-3 sm:gap-2">
                {form.rows.map((row, index) => {
                  const kept = row.private && row.saved && !row.value;
                  return (
                    <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto]">
                      <Input aria-label={`Detail ${index + 1}`} value={row.label} maxLength={DETAIL_LIMITS.fieldLabel} placeholder="Allergies" onChange={(event) => setRow(row.key, { label: event.target.value })} />
                      <Input
                        aria-label={row.label || `Detail ${index + 1}`}
                        className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto"
                        type={row.private ? "password" : "text"}
                        autoComplete={row.private ? "new-password" : "off"}
                        spellCheck={false}
                        value={row.value}
                        maxLength={DETAIL_LIMITS.value}
                        placeholder={kept ? "Saved. Type to replace it" : row.private ? "Private" : ""}
                        onChange={(event) => setRow(row.key, { value: event.target.value })}
                      />
                      <Toggle
                        variant="pill"
                        size="icon"
                        aria-label={`Keep ${row.label || "this detail"} private`}
                        title={row.private ? "Private: typed in for you, never shown" : "Readable by your bots"}
                        pressed={row.private}
                        // Made readable, a saved private value must be typed again: it is never sent back to show.
                        onPressedChange={(on) => setRow(row.key, { private: on, ...(on || !row.saved || row.value ? {} : { saved: false }) })}
                      >
                        {row.private ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
                      </Toggle>
                      <Button type="button" variant="ghost" size="icon-lg" className="pointer-coarse:size-11" aria-label={`Remove ${row.label || "this detail"}`} onClick={() => setForm((current) => ({ ...current, rows: current.rows.filter((r) => r.key !== row.key) }))}>
                        <X aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <Button type="button" variant="outline" className="self-start" disabled={form.rows.length >= DETAIL_LIMITS.fields} onClick={() => setForm((current) => ({ ...current, rows: [...current.rows, { key: rowKey(), label: "", value: "", private: false, saved: false }] }))}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add a detail
              </Button>
              <FieldDescription>The lock keeps a detail private: an ID or passport number, an insurance member ID. Your bots see only that it&apos;s there.</FieldDescription>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="detail-expires">Expires</FieldLabel>
              <Input id="detail-expires" type="date" className="sm:max-w-56" value={form.expiresOn} onChange={(event) => setForm((current) => ({ ...current, expiresOn: event.target.value }))} />
              <FieldDescription>For a passport, a licence or a policy. Your main bot tells you three months before, a month before and a week before.</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" size="lg" variant="outline" onClick={discard.requestClose}>
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={busy || !form.label.trim() || (!record && !touched)}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {discard.prompt}
    </Dialog>
  );
}

function summaryOf(record: DetailRecord): string {
  const saved = record.fields.filter((field) => field.saved);
  const hidden = saved.filter((field) => field.private).length;
  return `${DETAIL_KIND_LABELS[record.kind]} · ${saved.length} ${saved.length === 1 ? "detail" : "details"}${hidden ? `, ${hidden} private` : ""}`;
}

export function DetailsCard() {
  const [details, setDetails] = useState<DetailRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<DetailRecord | "new" | null>(null);
  const [removing, setRemoving] = useState<DetailRecord | null>(null);
  const shownRemoving = useHeld(removing, Boolean(removing));

  const load = useCallback(async () => {
    const data = await api<{ details: DetailRecord[] }>("/api/details").catch(() => null);
    setLoadFailed(!data);
    if (data) setDetails(data.details);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function remove(record: DetailRecord) {
    try {
      await del(`/api/details/${encodeURIComponent(record.id)}`);
      toast.add({ type: "success", title: `Removed ${record.label}.` });
    } catch (failure) {
      toast.add({ type: "error", title: `Couldn't remove ${record.label}.`, description: failure instanceof Error ? failure.message : undefined });
    } finally {
      setRemoving(null);
      void load();
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <CardTitle>Saved details</CardTitle>
          <CardDescription>The people in your household, IDs, insurance and vehicles. Your bots fill in forms with them, and your main bot tells you before something runs out. Private ones are typed in only after you say yes, and never shown.</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add details
        </Button>
      </CardHeader>
      <CardContent>
        {!details ? (
          loadFailed ? <LoadFailed what="your details" onRetry={() => void load()} /> : <Spinner />
        ) : details.length === 0 ? (
          <Empty className="border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookUser />
              </EmptyMedia>
              <EmptyTitle>Nothing saved yet</EmptyTitle>
              <EmptyDescription>Add someone in your household, a passport or your insurance, or tell a bot and it offers to save it here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {details.map((record) => {
              const Icon = KIND_ICONS[record.kind] ?? BookUser;
              return (
                <li key={record.id} className="flex items-center gap-3 rounded-xl border px-3 py-2">
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{record.label}</span>
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground">
                      {summaryOf(record)}
                      {record.expiresOn ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <Expiry day={record.expiresOn} />
                        </>
                      ) : null}
                    </span>
                  </span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Edit ${record.label}`} onClick={() => setEditing(record)}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove ${record.label}`} className="text-destructive" onClick={() => setRemoving(record)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {editing ? <DetailDialog record={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
      <Confirm
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${shownRemoving?.label ?? ""}?`}
        description="Your bots can't use these details any more, and nothing reminds you when they run out."
        action="Remove"
        cancel="Keep them"
        onConfirm={async () => removing && (await remove(removing))}
      />
    </Card>
  );
}
