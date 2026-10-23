"use client";

import { LOGIN_FIELD_LABELS, type LoginFieldKind, type SecretMeta } from "@gond/shared";
import { KeyRound, LogIn, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useHeld } from "@/hooks/use-held";
import { api, del } from "@/lib/api";

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
  const keys = (secrets ?? []).filter((secret) => !secret.site);
  const latest = (list: SecretMeta[]) => new Date(Math.max(...list.map((s) => Date.parse(s.updatedAt)))).toLocaleDateString();

  return (
    <>
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

      <AlertDialog open={Boolean(forgetting)} onOpenChange={(open) => !open && setForgetting(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {breakable(shownForgetting?.title ?? "")}?</AlertDialogTitle>
            <AlertDialogDescription>{shownForgetting?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onAction={async () => forgetting && (await forget(forgetting))}>
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
