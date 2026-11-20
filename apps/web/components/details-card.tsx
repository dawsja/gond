"use client";

import { CUSTOM_DETAIL, DETAIL_FIELD_TYPES, DETAIL_KIND_LABELS, DETAIL_KINDS, DETAIL_LIMITS, DETAIL_PRESETS, checkDetailValue, daysBetween, detailFieldType, toDay, type DetailInputKind, type DetailKind, type DetailRecord } from "@gond/shared";
import { BookUser, Car, HeartPulse, IdCard, Lock, LockOpen, Pencil, Plus, Trash2, UserRound, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentProps, type FormEvent } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { useDiscardChanges } from "@/components/discard-changes";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useHeld } from "@/hooks/use-held";
import { api, del, post } from "@/lib/api";

const KIND_ICONS: Record<DetailKind, LucideIcon> = { person: UserRound, document: IdCard, insurance: HeartPulse, vehicle: Car, other: BookUser };
const KIND_ITEMS = DETAIL_KINDS.map((kind) => ({ value: kind, label: DETAIL_KIND_LABELS[kind] }));
const SOMETHING_ELSE = "Something else";
const FIELD_ITEMS = [...DETAIL_FIELD_TYPES.map((type) => ({ value: type.id, label: type.label })), { value: CUSTOM_DETAIL, label: SOMETHING_ELSE }];
// A reminder comes 90 days ahead; inside a month, the list says so too.
const SOON_DAYS = 30;

/** `type` is a known detail's id, `CUSTOM_DETAIL` for one the person names, or empty until they pick. */
type Row = { key: string; id?: string; type: string; label: string; value: string; private: boolean; saved: boolean; checked: boolean };
type Form = { kind: DetailKind; label: string; expiresOn: string; rows: Row[] };

let rowKeys = 0;
const rowKey = () => `row-${(rowKeys += 1)}`;

const inputOf = (row: Pick<Row, "type">): DetailInputKind => detailFieldType(row.type)?.input ?? "text";

function presetRows(kind: DetailKind): Row[] {
  return DETAIL_PRESETS[kind].map((field) => {
    const known = detailFieldType(field.type);
    return { key: rowKey(), type: field.type, label: known?.label ?? field.label ?? "", value: "", private: known?.private ?? false, saved: false, checked: false };
  });
}

function formOf(record: DetailRecord | null, kind: DetailKind = "person"): Form {
  if (!record) return { kind, label: "", expiresOn: "", rows: presetRows(kind) };
  return {
    kind: record.kind,
    label: record.label,
    expiresOn: record.expiresOn ?? "",
    rows: record.fields.map((field) => {
      // A date typed as text before there was a calendar ("09/21/2000") opens as the day it names.
      const value = field.value ?? "";
      const tidy = inputOf(field) === "date" ? (toDay(value) ?? value) : value;
      return { key: rowKey(), id: field.id, type: field.type, label: field.label, value: tidy, private: field.private, saved: field.saved, checked: true };
    }),
  };
}

/** A form as far as saving goes: whether a row was looked at changes nothing. */
const comparable = (form: Form) => JSON.stringify({ ...form, rows: form.rows.map((row) => ({ ...row, checked: false })) });

/** What's wrong with a row as typed, in a few words, or null. */
function rowProblem(row: Row): string | null {
  if (!row.type) return row.value ? "Pick what this detail is." : null;
  if (row.type === CUSTOM_DETAIL && row.value && !row.label.trim()) return "Give this detail a name.";
  const checked = checkDetailValue(inputOf(row), row.value);
  return "error" in checked ? checked.error : null;
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

/** What each kind of value is typed with: the keyboard a phone shows, and an example. */
const TYPING: Record<Exclude<DetailInputKind, "date">, Pick<ComponentProps<typeof Input>, "type" | "inputMode" | "autoCapitalize" | "placeholder">> = {
  text: { type: "text" },
  email: { type: "email", inputMode: "email", autoCapitalize: "off", placeholder: "sam@example.com" },
  phone: { type: "tel", inputMode: "tel", placeholder: "+1 555 014 2000" },
  vin: { type: "text", autoCapitalize: "characters", placeholder: "17 letters and numbers" },
};

/** The list a row picks its detail from: the record's own kind first, then the rest, then one of the person's own. */
function FieldPicker({ row, kind, used, onPick }: { row: Row; kind: DetailKind; used: Set<string>; onPick: (type: string) => void }) {
  const kinds = DETAIL_KINDS.filter((k) => k !== "other").sort((a, b) => (a === kind ? -1 : b === kind ? 1 : 0));
  return (
    <Select items={FIELD_ITEMS} value={row.type || null} onValueChange={(value) => value && onPick(String(value))}>
      <SelectTrigger aria-label="What this detail is" className="w-full" aria-invalid={row.checked && !row.type && Boolean(row.value) ? true : undefined}>
        <SelectValue placeholder="Pick a detail" />
      </SelectTrigger>
      <SelectContent>
        {kinds.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{DETAIL_KIND_LABELS[group]}</SelectLabel>
            {DETAIL_FIELD_TYPES.filter((type) => type.kind === group).map((type) => (
              <SelectItem key={type.id} value={type.id} disabled={used.has(type.id) && type.id !== row.type}>
                {type.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        <SelectGroup>
          <SelectItem value={CUSTOM_DETAIL}>{SOMETHING_ELSE}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** One record's details, new or changed; a private one is never shown, and stays as it is while left empty. */
function DetailDialog({ record, onClose, onSaved }: { record: DetailRecord | null; onClose: () => void; onSaved: () => void }) {
  const [initial] = useState<Form>(() => formOf(record));
  const [start] = useState(() => comparable(initial));
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [thisYear] = useState(() => new Date().getFullYear());
  const dirty = comparable(form) !== start;
  const discard = useDiscardChanges(dirty && !busy, onClose);
  const touched = form.rows.some((row) => row.value) || form.label;
  const used = new Set(form.rows.map((row) => row.type));

  const setRow = (key: string, change: Partial<Row>) => setForm((current) => ({ ...current, rows: current.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));

  /** A row changes what it is: a known detail takes its name and whether it starts private, and keeps a value only that fits. */
  function pickField(row: Row, type: string) {
    const known = detailFieldType(type);
    const fits = known ? !("error" in checkDetailValue(known.input, row.value)) : true;
    setRow(row.key, { type, label: known?.label ?? "", private: row.saved ? row.private : (known?.private ?? false), value: fits ? row.value : "", checked: false });
  }

  function pickKind(kind: DetailKind) {
    // A new record's fields follow its kind until anything is typed into them.
    setForm((current) => ({ ...current, kind, rows: record || current.rows.some((row) => row.value) ? current.rows : presetRows(kind) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (form.rows.some(rowProblem)) {
      setTried(true);
      setError("Fix the details marked above.");
      return;
    }
    setBusy(true);
    const body = {
      kind: form.kind,
      label: form.label,
      expiresOn: form.expiresOn || null,
      fields: form.rows.filter((row) => row.type).map((row) => ({ ...(row.id ? { id: row.id } : {}), type: row.type, label: row.label, private: row.private, value: row.value })),
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
        <form onSubmit={save} noValidate className="contents">
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
                {form.rows.map((row) => {
                  const kept = row.private && row.saved && !row.value;
                  const input = inputOf(row);
                  // A row says what's wrong once it's been left or a save was tried, never mid-typing.
                  const problem = row.checked || tried ? rowProblem(row) : null;
                  const name = row.label || "this detail";
                  const valueClass = "col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto";
                  return (
                    <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto]">
                      {row.type === CUSTOM_DETAIL ? (
                        <Input aria-label="Name of this detail" autoFocus={!row.label && !row.saved} value={row.label} maxLength={DETAIL_LIMITS.fieldLabel} placeholder="Name it, like School" onChange={(event) => setRow(row.key, { label: event.target.value })} />
                      ) : (
                        <FieldPicker row={row} kind={form.kind} used={used} onPick={(type) => pickField(row, type)} />
                      )}
                      {!row.type ? (
                        <Input aria-label="Value" className={valueClass} disabled placeholder="Pick what it is first" />
                      ) : input === "date" ? (
                        <DatePicker
                          aria-label={name}
                          className={valueClass}
                          value={row.value}
                          placeholder={kept ? "Saved. Pick to replace it" : "Pick a date"}
                          fromYear={row.type === "date_of_birth" ? 1900 : thisYear - 60}
                          toYear={row.type === "date_of_birth" ? thisYear : thisYear + 30}
                          onChange={(day) => setRow(row.key, { value: day, checked: true })}
                        />
                      ) : (
                        <Input
                          aria-label={name}
                          aria-invalid={problem ? true : undefined}
                          className={valueClass}
                          {...TYPING[input]}
                          type={row.private ? "password" : TYPING[input].type}
                          autoComplete={row.private ? "new-password" : "off"}
                          spellCheck={false}
                          value={row.value}
                          maxLength={DETAIL_LIMITS.value}
                          placeholder={kept ? "Saved. Type to replace it" : row.private ? "Private" : TYPING[input].placeholder}
                          onChange={(event) => setRow(row.key, { value: input === "vin" ? event.target.value.toUpperCase() : event.target.value })}
                          onBlur={() => setRow(row.key, { checked: true })}
                        />
                      )}
                      <Toggle
                        variant="pill"
                        size="icon"
                        aria-label={`Keep ${name} private`}
                        title={row.private ? "Private: typed in for you, never shown" : "Readable by your bots"}
                        pressed={row.private}
                        // Made readable, a saved private value must be typed again: it is never sent back to show.
                        onPressedChange={(on) => setRow(row.key, { private: on, ...(on || !row.saved || row.value ? {} : { saved: false }) })}
                      >
                        {row.private ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
                      </Toggle>
                      <Button type="button" variant="ghost" size="icon-lg" className="pointer-coarse:size-11" aria-label={`Remove ${name}`} onClick={() => setForm((current) => ({ ...current, rows: current.rows.filter((r) => r.key !== row.key) }))}>
                        <X aria-hidden="true" />
                      </Button>
                      {problem ? <FieldError className="col-span-full -mt-1">{problem}</FieldError> : null}
                    </li>
                  );
                })}
              </ul>
              <Button type="button" variant="outline" className="self-start" disabled={form.rows.length >= DETAIL_LIMITS.fields} onClick={() => setForm((current) => ({ ...current, rows: [...current.rows, { key: rowKey(), type: "", label: "", value: "", private: false, saved: false, checked: false }] }))}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add a detail
              </Button>
              <FieldDescription>Pick a detail from the list and it&apos;s checked as you type: a date from a calendar, an email with its @, a phone number. Something else takes any name and words. The lock keeps a detail private, like an ID or passport number; your bots see only that it&apos;s there.</FieldDescription>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="detail-expires">Expires</FieldLabel>
              <DatePicker id="detail-expires" className="sm:max-w-56" value={form.expiresOn} placeholder="Doesn't expire" clearable fromYear={thisYear - 10} toYear={thisYear + 30} onChange={(day) => setForm((current) => ({ ...current, expiresOn: day }))} />
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
