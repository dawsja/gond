"use client";

import { cardLabel, looseCards, LOGIN_FIELD_LABELS, type LoginFieldKind, type SecretMeta } from "@gond/shared";
import { CreditCard, Info, KeyRound, LogIn, Pencil, Plus, Trash2 } from "lucide-react";
import { cardBody, CardFields, cardLine, CardMark, EMPTY_CARD, type CardValues } from "@/components/card-form";
import { failed } from "@/components/failed";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { Confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useHeld } from "@/hooks/use-held";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, del, post } from "@/lib/api";

type Forgetting = { title: string; names: string[]; detail: string };

type Changing = { title: string; fields: { name: string; label: string; hidden: boolean }[] };

/** "UBER_EATS_PASSWORD" is the Uber Eats password: its kind is the name's last word. */
function detailOf(secret: SecretMeta): Changing["fields"][number] {
  const kind = /_(EMAIL|USERNAME|PHONE|PASSWORD|CODE)(?:_\d+)?$/.exec(secret.name)?.[1]?.toLowerCase() as LoginFieldKind | undefined;
  return { name: secret.name, label: kind ? LOGIN_FIELD_LABELS[kind] : secret.name, hidden: !kind || kind === "password" || kind === "code" };
}

/** New values for saved secrets, typed in place of what is there; what is there is never shown. */
function ChangeDialog({ changing, onClose, onSaved }: { changing: Changing; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const given = changing.fields.filter((field) => values[field.name]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!given.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const field of given) await api(`/api/secrets/${encodeURIComponent(field.name)}`, { method: "PUT", body: JSON.stringify({ value: values[field.name] }) });
      toast.add({ type: "success", title: `Changed ${changing.title}.` });
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save it.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change {breakable(changing.title)}</DialogTitle>
          <DialogDescription>What&apos;s saved now is never shown. Type a new value to replace it; it&apos;s encrypted again as it&apos;s saved.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="contents">
          <FieldGroup className="gap-4">
            {changing.fields.map((field) => (
              <Field key={field.name}>
                <FieldLabel htmlFor={`change-${field.name}`}>{changing.fields.length > 1 ? field.label : "New value"}</FieldLabel>
                <Input
                  id={`change-${field.name}`}
                  type={field.hidden ? "password" : "text"}
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={8000}
                  placeholder={changing.fields.length > 1 ? "Leave as it is" : undefined}
                  value={values[field.name] ?? ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                />
              </Field>
            ))}
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" size="lg" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={!given.length || busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A new card, or new details for a saved one; with `card`, every field may stay empty to keep what it had. */
function CardDialog({ card, onClose, onSaved }: { card: SecretMeta | null; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<CardValues>({ ...EMPTY_CARD, nickname: card?.card?.nickname ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (card) await api(`/api/cards/${encodeURIComponent(card.name)}`, { method: "PUT", body: JSON.stringify(cardBody(values)) });
      else await post("/api/cards", cardBody(values));
      toast.add({ type: "success", title: card ? "Card changed." : "Card saved." });
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the card.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{card?.card ? `Change ${cardLabel(card.card)}` : "Add a card"}</DialogTitle>
          <DialogDescription>{card ? "What's saved now is never shown. Type only what changed; anything left empty stays as it is." : "Saved once, for any site. Encrypted, and a bot types it into a checkout only after you say yes."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="contents">
          <CardFields id="card-dialog" values={values} onChange={setValues} keep={Boolean(card)} />
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" size="lg" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="lg" variant="tint" disabled={busy || (!card && (!values.number || !values.expiry || !values.cvc))}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {card ? "Save" : "Save card"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CardsCard({ secrets, loadFailed, onReload, onForget }: { secrets: SecretMeta[] | null; loadFailed: boolean; onReload: () => void; onForget: (target: Forgetting) => void }) {
  const [editing, setEditing] = useState<SecretMeta | "new" | null>(null);
  const [combining, setCombining] = useState(false);
  const cards = (secrets ?? []).filter((secret) => secret.card);
  const loose = looseCards((secrets ?? []).filter((secret) => !secret.card && !secret.site).map((secret) => secret.name));

  async function combine(prefix: string) {
    setCombining(true);
    try {
      await post("/api/cards/combine", { prefix });
      toast.add({ type: "success", title: "Made them into one card." });
      onReload();
    } catch (failure) {
      failed("Couldn't make them a card.")(failure);
    } finally {
      setCombining(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <CardTitle>Cards</CardTitle>
          <CardDescription>Save a card once and any bot can pay with it on any site. It types the card into the checkout only after you say yes, every time, and never sees it.</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add a card
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loose.map((group) => (
          <Alert key={group.prefix}>
            <Info aria-hidden="true" />
            <AlertDescription className="flex flex-col items-start gap-2.5">
              <span>
                {Object.keys(group.parts).length} of your keys look like one card: {breakable(fewNames(PART_ORDER.flatMap((part) => group.parts[part] ?? [])))}.
              </span>
              <Button size="sm" variant="tint" disabled={combining} onClick={() => void combine(group.prefix)}>
                {combining ? <Spinner data-icon="inline-start" /> : null}
                Make it a card
              </Button>
            </AlertDescription>
          </Alert>
        ))}
        {!secrets ? (
          loadFailed ? <LoadFailed what="your cards" onRetry={onReload} /> : <Spinner />
        ) : cards.length === 0 ? (
          <Empty className="border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CreditCard />
              </EmptyMedia>
              <EmptyTitle>No cards</EmptyTitle>
              <EmptyDescription>Add one here, or save it from the card a bot shows you at a checkout.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {cards.map((secret) => (
              <li key={secret.name} className="flex items-center gap-3 rounded-xl border px-3 py-2">
                <CardMark brand={secret.card!.brand} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{cardLabel(secret.card!)}</span>
                  <span className="block text-[12px] text-muted-foreground">{cardLine(secret.card!)}</span>
                </span>
                <Button variant="ghost" size="icon-xs" aria-label={`Change ${cardLabel(secret.card!)}`} onClick={() => setEditing(secret)}>
                  <Pencil aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label={`Forget ${cardLabel(secret.card!)}`} className="text-destructive" onClick={() => onForget({ title: cardLabel(secret.card!), names: [secret.name], detail: "Your bots can't pay with it any more. Add it again any time." })}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing ? <CardDialog card={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={onReload} /> : null}
    </Card>
  );
}

const PART_ORDER = ["number", "expiry", "cvc", "zip", "name"] as const;

/** "A, B and 2 others": a long list of names says only the first two. */
function fewNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

// A name like BACKUP_ENCRYPTION_PASSWORD has no spaces, so it may break after each underscore.
function breakable(text: string) {
  return text.split(/(?<=_)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

export function SecretsCard() {
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [forgetting, setForgetting] = useState<Forgetting | null>(null);
  const shownForgetting = useHeld(forgetting, Boolean(forgetting));
  const [changing, setChanging] = useState<Changing | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    const data = await api<{ secrets: SecretMeta[] }>("/api/secrets").catch(() => null);
    setLoadFailed(!data);
    if (data) setSecrets(data.secrets);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function forget(target: Forgetting) {
    try {
      for (const name of target.names) await del(`/api/secrets/${encodeURIComponent(name)}`);
      toast.add({ type: "success", title: `Forgot ${target.title}.` });
    } catch (failure) {
      toast.add({ type: "error", title: `Couldn't forget ${target.title}.`, description: failure instanceof Error ? failure.message : undefined });
    } finally {
      setForgetting(null);
      void load();
    }
  }

  const sites = new Map<string, SecretMeta[]>();
  for (const secret of secrets ?? []) if (secret.site) sites.set(secret.site, [...(sites.get(secret.site) ?? []), secret]);
  const keys = (secrets ?? []).filter((secret) => !secret.site && !secret.card);
  const latest = (list: SecretMeta[]) => new Date(Math.max(...list.map((s) => Date.parse(s.updatedAt)))).toLocaleDateString();

  return (
    <>
      <CardsCard secrets={secrets} loadFailed={loadFailed} onReload={() => void load()} onForget={setForgetting} />
      <Card>
        <CardHeader>
          <CardTitle>Saved sign-ins</CardTitle>
          <CardDescription>Websites you asked a bot to remember. A bot types them into the page for you and never sees them.</CardDescription>
        </CardHeader>
        <CardContent>
          {!secrets ? (
            loadFailed ? <LoadFailed what="your secrets" onRetry={() => void load()} /> : <Spinner />
          ) : sites.size === 0 ? (
            <Empty className="border py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LogIn />
                </EmptyMedia>
                <EmptyTitle>No saved sign-ins</EmptyTitle>
                <EmptyDescription>When a bot signs you in to a website, turn on Remember for next time on its card.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {[...sites].map(([site, list]) => (
                <li key={site} className="flex items-center gap-3 rounded-xl border px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{site}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {list.length} {list.length === 1 ? "detail" : "details"} · saved {latest(list)}
                    </span>
                  </span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Change your ${site} sign-in`} onClick={() => setChanging({ title: `your ${site} sign-in`, fields: list.map(detailOf) })}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Forget ${site}`} className="text-destructive" onClick={() => setForgetting({ title: `your ${site} sign-in`, names: list.map((s) => s.name), detail: `The next time a bot signs you in to ${site}, it will ask with a card again.` })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
          <CardDescription>API keys and tokens your bots asked you for, stored encrypted. Only their names are shown; change one here when it&apos;s replaced, or a bot asks again when it needs a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          {!secrets ? (
            loadFailed ? <LoadFailed what="your secrets" onRetry={() => void load()} /> : <Spinner />
          ) : keys.length === 0 ? (
            <Empty className="border py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRound />
                </EmptyMedia>
                <EmptyTitle>No keys</EmptyTitle>
                <EmptyDescription>When a bot needs one, it asks you with a card in the conversation.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {keys.map((secret) => (
                <li key={secret.name} className="flex items-center gap-3 rounded-xl border px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13.5px] font-medium">{secret.name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">Saved {new Date(secret.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Change ${secret.name}`} onClick={() => setChanging({ title: secret.name, fields: [{ name: secret.name, label: secret.name, hidden: true }] })}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Forget ${secret.name}`} className="text-destructive" onClick={() => setForgetting({ title: secret.name, names: [secret.name], detail: "Anything that uses it, like an MCP server's headers, stops working until a bot asks you for it again." })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {changing ? <ChangeDialog changing={changing} onClose={() => setChanging(null)} onSaved={() => void load()} /> : null}

      <Confirm
        open={Boolean(forgetting)}
        onOpenChange={(open) => !open && setForgetting(null)}
        title={`Forget ${shownForgetting?.title ?? ""}?`}
        description={shownForgetting?.detail ?? ""}
        action="Forget"
        cancel="Keep it"
        onConfirm={async () => forgetting && (await forget(forgetting))}
      />
    </>
  );
}
