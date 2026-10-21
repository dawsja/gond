"use client";

import { composioCardToolkit, type Bot, type McpServer, type Message } from "@gond/shared";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionCard, ActionCardDone } from "@/components/action-card";
import { ConnectCard } from "@/components/connect-card";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { McpPasteSignIn, startMcpSignIn } from "@/components/mcp-signin";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

export function SignInCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const toolkit = composioCardToolkit(message.approvalId);
  if (toolkit) return <ConnectCard message={message} bot={bot} toolkit={toolkit} />;
  return <McpSignInCard message={message} bot={bot} />;
}

function McpSignInCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const id = message.approvalId;
  const [server, setServer] = useState<McpServer | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [waiting, setWaiting] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ servers: McpServer[] }>("/api/mcp-servers").catch(() => null);
    if (data) setServer(data.servers.find((s) => s.id === id) ?? null);
  }, [id]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void load();
  });

  async function signIn() {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await startMcpSignIn(server, message.threadId)) {
        setWaiting(true);
        setBusy(false);
      }
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not start the sign-in.");
      void load();
    }
  }

  const name = server?.name ?? message.body.replace(/^Sign in to /, "");
  let host = "";
  try {
    host = server?.url ? new URL(server.url).host : "";
  } catch {
    /* not a URL */
  }

  const by = bot?.name ?? "A bot";
  const icon = <ShieldCheck aria-hidden="true" />;
  if (server === null) return <ActionCardDone icon={icon} title={name} by={`${by} · MCP server`} status="Removed" tone="neutral" />;
  if (server?.authStatus === "signed_in" || server?.authStatus === "none") return <ActionCardDone icon={icon} title={name} by={host || `${by} · MCP server`} status={server.authStatus === "signed_in" ? "Signed in" : "Connected"} tone="ok" />;

  return (
    <ActionCard
      icon={icon}
      title={`Sign in to ${name}`}
      by={server === undefined ? <Spinner aria-label="Loading" /> : host ? `${by} added it · ${host}` : `${by} added it`}
      actions={
        <Button size="xl" variant={waiting ? "outline" : "default"} className="w-full" disabled={busy || !server?.enabled} onClick={() => void signIn()}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {waiting ? "Open the sign-in again" : server?.authStatus === "error" ? "Try again" : `Sign in to ${name}`}
        </Button>
      }
      note={`You sign in on ${host || "the app's own site"}. Gond keeps the token and the bots never see it.`}
    >
      {(server?.authStatus === "error" && server.authError) || error ? (
        <p className="flex items-start gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error ?? server?.authError}
        </p>
      ) : null}
      {waiting ? <McpPasteSignIn name={name} onDone={() => void load()} /> : null}
    </ActionCard>
  );
}
