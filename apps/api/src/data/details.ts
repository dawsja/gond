import { CUSTOM_DETAIL, DETAIL_LIMITS, detailTypeFor, sameDetailName, type DetailInput, type DetailKind, type DetailRecord } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/** A field as it is sealed in the row, with its value whatever it is; `type` is missing on one saved before there were types. */
export type SealedField = { id: string; type?: string; label: string; private: boolean; value: string };

const typeOf = (field: SealedField) => field.type ?? detailTypeFor(field.label)?.id ?? CUSTOM_DETAIL;

type Row = { id: string; user_id: string; kind: DetailKind; label: string; fields: string; expires_on: string | null; reminded: number | null; created_at: string; updated_at: string };

function unseal(row: Pick<Row, "fields">): SealedField[] {
  try {
    const parsed = JSON.parse(decryptSecret(row.fields)) as unknown;
    return Array.isArray(parsed) ? (parsed as SealedField[]) : [];
  } catch {
    return [];
  }
}

function toRecord(row: Row, fields = unseal(row)): DetailRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    expiresOn: row.expires_on,
    fields: fields.map((f) => ({ id: f.id, type: typeOf(f), label: f.label, private: f.private, saved: f.value !== "", value: f.private ? null : f.value })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowsOf(userId: string): Row[] {
  return ensureDatabase().query("SELECT * FROM gond_details WHERE user_id = ? ORDER BY label COLLATE NOCASE").all(userId) as Row[];
}

export function listDetails(userId: string): DetailRecord[] {
  return rowsOf(userId).map((row) => toRecord(row));
}

function rowOf(userId: string, id: string): Row | null {
  return ensureDatabase().query("SELECT * FROM gond_details WHERE user_id = ? AND id = ?").get(userId, id) as Row | null;
}

export function getDetail(userId: string, id: string): DetailRecord | null {
  const row = rowOf(userId, id);
  return row ? toRecord(row) : null;
}

export function findDetail(userId: string, ref: string): DetailRecord | null {
  const wanted = ref.trim();
  if (!wanted) return null;
  const rows = rowsOf(userId);
  const row = rows.find((r) => r.id === wanted) ?? rows.find((r) => sameDetailName(r.label, wanted));
  return row ? toRecord(row) : null;
}

/** A record's fields with every value, for typing into a page the person allowed. Never send them to a route. */
export function readDetailFields(userId: string, id: string): SealedField[] | null {
  const row = rowOf(userId, id);
  return row ? unseal(row) : null;
}

/**
 * Saves a record the person typed: with `id`, over the one they edited. A private field left empty keeps
 * the value it had, as long as it was private before too, so a value shown nowhere is never needed to
 * edit the rest; one switched from private to readable must be typed again, so it can't be read that way.
 */
export function saveDetail(userId: string, input: DetailInput, id?: string): DetailRecord | { error: string } {
  return transaction((db) => {
    const current = id ? rowOf(userId, id) : null;
    if (id && !current) return { error: "Couldn't find those details" };
    const others = rowsOf(userId).filter((row) => row.id !== id);
    if (!current && others.length >= DETAIL_LIMITS.records) return { error: `You can keep up to ${DETAIL_LIMITS.records} sets of details. Remove one you don't need first.` };
    if (others.some((row) => sameDetailName(row.label, input.label))) return { error: `You already have details called ${input.label}. Give these another name.` };
    const before = current ? unseal(current) : [];
    const fields: SealedField[] = input.fields.map((field) => {
      const was = field.id ? before.find((f) => f.id === field.id) : undefined;
      const value = field.private && !field.value && was?.private ? was.value : field.value;
      return { id: was?.id ?? newId("df"), type: field.type, label: field.label, private: field.private, value };
    });
    const at = now();
    const sealed = encryptSecret(JSON.stringify(fields));
    const record = current?.id ?? newId("d");
    if (current) {
      const reminded = current.expires_on === input.expiresOn ? current.reminded : null;
      db.query("UPDATE gond_details SET kind = ?, label = ?, fields = ?, expires_on = ?, reminded = ?, updated_at = ? WHERE id = ?").run(input.kind, input.label, sealed, input.expiresOn, reminded, at, record);
    } else {
      db.query("INSERT INTO gond_details (id, user_id, kind, label, fields, expires_on, reminded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(record, userId, input.kind, input.label, sealed, input.expiresOn, at, at);
    }
    settingsChanged(userId);
    return toRecord(rowOf(userId, record)!, fields);
  });
}

export function addDetailFields(userId: string, label: string, kind: DetailKind, given: { type: string; label: string; value: string }[], expiresOn: string | null): DetailRecord | { error: string } {
  const current = findDetail(userId, label);
  const before = current ? readDetailFields(userId, current.id) ?? [] : [];
  const fields = before.map((f) => ({ id: f.id, type: typeOf(f), label: f.label, private: f.private, value: f.value }));
  for (const field of given) {
    const at = fields.findIndex((f) => (field.type !== CUSTOM_DETAIL && f.type === field.type) || sameDetailName(f.label, field.label));
    if (at >= 0 && fields[at]!.private) return { error: `${field.label} is private: only the person changes it, in Settings → Your details` };
    if (at >= 0) fields[at] = { ...fields[at]!, value: field.value };
    else fields.push({ id: "", type: field.type, label: field.label, private: false, value: field.value });
  }
  if (fields.length > DETAIL_LIMITS.fields) return { error: `a record holds up to ${DETAIL_LIMITS.fields} details` };
  // The person's own private values pass through as empty, which keeps them.
  const input: DetailInput = {
    kind: current?.kind ?? kind,
    label: current?.label ?? label,
    expiresOn: expiresOn ?? current?.expiresOn ?? null,
    fields: fields.map((f) => ({ ...(f.id ? { id: f.id } : {}), type: f.type, label: f.label, private: f.private, value: f.private ? "" : f.value })),
  };
  return saveDetail(userId, input, current?.id);
}

export function deleteDetail(userId: string, id: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_details WHERE user_id = ? AND id = ?").run(userId, id).changes > 0;
  if (changed) settingsChanged(userId);
  return changed;
}

/** Every private value anyone keeps, so nothing a bot says or reads back shows one. */
export function privateDetailValues(): string[] {
  const rows = ensureDatabase().query("SELECT fields FROM gond_details").all() as Pick<Row, "fields">[];
  return rows.flatMap((row) => unseal(row).flatMap((f) => (f.private && f.value ? [f.value] : [])));
}

export type ExpiringDetail = { id: string; userId: string; label: string; kind: DetailKind; expiresOn: string; reminded: number | null };

/** Records that run out by `until` (YYYY-MM-DD), for the reminders' sweep, which decides by each person's own date. */
export function expiringDetails(until: string): ExpiringDetail[] {
  const rows = ensureDatabase().query("SELECT id, user_id, label, kind, expires_on, reminded FROM gond_details WHERE expires_on IS NOT NULL AND expires_on <= ?").all(until) as Pick<Row, "id" | "user_id" | "label" | "kind" | "expires_on" | "reminded">[];
  return rows.map((row) => ({ id: row.id, userId: row.user_id, label: row.label, kind: row.kind, expiresOn: row.expires_on!, reminded: row.reminded }));
}

export function markReminded(id: string, expiresOn: string, stage: number): boolean {
  return ensureDatabase().query("UPDATE gond_details SET reminded = ? WHERE id = ? AND expires_on = ? AND (reminded IS NULL OR reminded > ?)").run(stage, id, expiresOn, stage).changes > 0;
}
