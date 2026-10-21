"use client";

import { type SecretMeta } from "@gond/shared";
import { KeyRound, LogIn, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, del } from "@/lib/api";

type Forgetting = { title: string; names: string[]; detail: string };

// A name like BACKUP_ENCRYPTION_PASSWORD has no spaces, so it may break after each underscore.
function breakable(text: string) {
  return text.split(/(?<=_)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

export function SecretsCard() {
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [forgetting, setForgetting] = useState<Forgetting | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ secrets: SecretMeta[] }>("/api/secrets").catch(() => null);
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
      toast.add({ type: "error", title: `Could not forget ${target.title}.`, description: failure instanceof Error ? failure.message : undefined });
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
            <Spinner />
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
          <CardDescription>API keys and tokens your bots asked you for, stored encrypted. Only their names are shown; a bot asks again when it needs a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          {!secrets ? (
            <Spinner />
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
                  <Button variant="ghost" size="icon-xs" aria-label={`Forget ${secret.name}`} className="text-destructive" onClick={() => setForgetting({ title: secret.name, names: [secret.name], detail: "Anything that uses it, like an MCP server's headers, stops working until a bot asks you for it again." })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(forgetting)} onOpenChange={(open) => !open && setForgetting(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {breakable(forgetting?.title ?? "")}?</AlertDialogTitle>
            <AlertDialogDescription>{forgetting?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => forgetting && void forget(forgetting)}>
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
