"use client";

import type { AppCatalogEntry, Bot, Connection, Message } from "@gond/shared";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionCard, ActionCardDone, cheerOnFold } from "@/components/action-card";
import { AppIcon, appName } from "@/components/app-icons";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, apiShared, post } from "@/lib/api";

export function ConnectCard({ message, bot, toolkit }: { message: Message; bot: Bot | undefined; toolkit: string }) {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [app, setApp] = useState<AppCatalogEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const [found, connections] = await Promise.all([
      api<{ app: AppCatalogEntry }>(`/api/catalog/${encodeURIComponent(toolkit)}`).catch(() => null),
      apiShared<{ connections: Connection[] }>("/api/connections").catch(() => null),
    ]);
    if (found) setApp(found.app);
    setLoadFailed(!connections);
    if (connections) setConnection(connections.connections.find((c) => c.toolkit === toolkit) ?? null);
  }, [toolkit]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    cheerOnFold(message.id);
    try {
      const started = await post<{ redirectUrl: string | null }>(`/api/connections/${toolkit}/connect`, { threadId: message.threadId });
      if (started.redirectUrl) {
        setWaiting(true);
        window.location.assign(started.redirectUrl);
        return;
      }
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start the connection.");
    } finally {
      setBusy(false);
    }
  }

  const name = app?.name ?? appName(toolkit);
  const by = bot?.name ?? "A bot";
  const icon = <AppIcon toolkit={toolkit} logo={app?.logo} size={20} />;
  if (connection?.status === "active") return <ActionCardDone id={message.id} bot={bot} icon={icon} title={name} by={`${by} · connected app`} status="Connected" tone="ok" />;

  return (
    <ActionCard
      icon={icon}
      title={`Connect ${name}`}
      by={connection === undefined ? (loadFailed ? "Couldn't load this. Try again." : <Spinner aria-label="Loading" />) : `${by} needs it. Sign in once and every bot of yours can use it.`}
      actions={
        <Button size="xl" variant="tint" className="w-full" disabled={busy || waiting || (connection === undefined && !loadFailed)} onClick={() => void (connection === undefined ? load() : connect())}>
          {busy || waiting ? <Spinner data-icon="inline-start" /> : null}
          {waiting ? "Opening the sign-in…" : connection === undefined && loadFailed ? "Try again" : connection?.status === "pending" ? `Finish connecting ${name}` : `Connect ${name}`}
        </Button>
      }
      note={`You sign in on ${name}'s own site. Your bots use the connection but never see your password.`}
    >
      {connection?.status === "failed" || error ? (
        <p className="flex items-start gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error ?? "The last sign-in didn't finish. Try again."}
        </p>
      ) : null}
    </ActionCard>
  );
}
