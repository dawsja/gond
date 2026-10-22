"use client";

import type { Bot, Message, SecretRequest } from "@gond/shared";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ActionCard, ActionCardDone, cheerOnFold } from "@/components/action-card";
import { LoginCard } from "@/components/login-card";
import { useLiveEvents } from "@/components/hq/live-events";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { api, post } from "@/lib/api";

export function SecretCard({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const [request, setRequest] = useState<SecretRequest | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = message.approvalId;

  const load = () => {
    if (!id) return;
    void api<{ request: SecretRequest }>(`/api/secret-requests/${id}`)
      .then((d) => setRequest(d.request))
      .catch(() => undefined);
  };
  useEffect(() => {
    void Promise.resolve().then(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useLiveEvents((event) => {
    if (event.topic === "approvals" || (event.topic === "thread" && event.threadId === message.threadId)) load();
  });

  if (request?.target === "login") return <LoginCard request={request} bot={bot} onAnswered={setRequest} />;
  const name = bot?.name ?? "A bot";
  const icon = <KeyRound aria-hidden="true" />;
  if (!request) return <ActionCard bot={bot} icon={icon} title={`${name} needs something from you`} by={<Spinner aria-label="Loading" />} />;

  const [secret, ...reasonParts] = message.body.split(": ");
  const reason = reasonParts.join(": ");
  const composio = request.target === "composio";
  const label = composio ? "Composio API key" : secret;

  if (request.status !== "pending") {
    const done = request.status === "given" ? { status: "Saved", tone: "ok" as const } : request.status === "declined" ? { status: "Not now", tone: "neutral" as const } : { status: "Expired", tone: "neutral" as const };
    return <ActionCardDone id={message.id} bot={bot} icon={icon} title={label} by={`${name} · ${composio ? "connected apps" : "secret"}`} status={done.status} tone={done.tone} />;
  }

  async function answer(event?: FormEvent, decline = false) {
    event?.preventDefault();
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ request: SecretRequest }>(`/api/secret-requests/${id}`, decline ? { decline: true } : { value });
      if (!decline) cheerOnFold(message.id);
      setRequest(data.request);
      setValue("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={answer} className="contents">
      <ActionCard
        bot={bot}
        icon={icon}
        title={composio ? `${name} needs your Composio key` : `${name} needs a secret`}
        by={reason || undefined}
        actions={
          <>
            <Button type="submit" size="xl" variant="tint" className="w-full" disabled={busy || !value}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
            <Button type="button" size="xl" variant="outline" className="w-full" disabled={busy} onClick={() => void answer(undefined, true)}>
              Not now
            </Button>
          </>
        }
        note={composio ? "Encrypted, and used only when Gond talks to Composio. The bot never sees it." : `Encrypted. ${name} uses it without ever seeing it, and it never shows in the chat.`}
      >
        {composio ? (
          <p className="text-[13.5px] text-muted-foreground">
            It connects your apps (Gmail, GitHub, Notion and the rest). A free key comes from{" "}
            <a href="https://dashboard.composio.dev" target="_blank" rel="noreferrer noopener" className="text-foreground underline underline-offset-2">
              dashboard.composio.dev
            </a>{" "}
            under Settings → API keys.
          </p>
        ) : null}
        <FieldGroup className="gap-2">
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`secret-${id}`} className={composio ? undefined : "font-mono text-[12.5px]"}>
              {label}
            </FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <KeyRound aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput id={`secret-${id}`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" placeholder="Paste it here" aria-invalid={error ? true : undefined} />
            </InputGroup>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
      </ActionCard>
    </form>
  );
}
