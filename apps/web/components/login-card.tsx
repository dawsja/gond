"use client";

import { LOGIN_FIELD_LABELS, type Bot, type LoginField, type SecretRequest } from "@gond/shared";
import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ActionCard, ActionCardDone } from "@/components/action-card";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { post } from "@/lib/api";

const INPUTS: Record<LoginField["kind"], { type: string; autoComplete: string; inputMode?: "email" | "tel" | "numeric" }> = {
  email: { type: "email", autoComplete: "off", inputMode: "email" },
  username: { type: "text", autoComplete: "off" },
  phone: { type: "tel", autoComplete: "off", inputMode: "tel" },
  password: { type: "password", autoComplete: "off" },
  code: { type: "text", autoComplete: "one-time-code", inputMode: "numeric" },
};

export function LoginCard({ request, bot, onAnswered }: { request: SecretRequest; bot: Bot | undefined; onAnswered: (request: SecretRequest) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = request.site ?? request.name;
  const canRemember = request.fields.some((field) => field.kind !== "code");
  const filled = request.fields.every((field) => values[field.name]);

  async function answer(event?: FormEvent, decline = false) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ request: SecretRequest }>(`/api/secret-requests/${request.id}`, decline ? { decline: true } : { values, remember: canRemember && remember });
      setValues({});
      onAnswered(data.request);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send it.");
    } finally {
      setBusy(false);
    }
  }

  const name = bot?.name ?? "A bot";
  const icon = <LogIn aria-hidden="true" />;
  if (request.status !== "pending") {
    const done = request.status === "given" ? { status: "Sent", tone: "ok" as const } : request.status === "declined" ? { status: "Not now", tone: "neutral" as const } : { status: "Expired", tone: "neutral" as const };
    return <ActionCardDone icon={icon} title={`Sign in to ${site}`} by={name} status={done.status} tone={done.tone} />;
  }

  return (
    <form onSubmit={answer} className="contents">
      <ActionCard
        icon={icon}
        title={`Sign in to ${site}`}
        by={request.reason || `${name} is on the sign-in page`}
        actions={
          <>
            <Button type="submit" size="xl" className="w-full" disabled={busy || !filled}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Sign in
            </Button>
            <Button type="button" size="xl" variant="outline" className="w-full" disabled={busy} onClick={() => void answer(undefined, true)}>
              Not now
            </Button>
          </>
        }
        note={`Typed into the page by Gond. ${name} never sees it, and it stays out of the chat.`}
      >
        <FieldGroup className="gap-3">
          {request.fields.map((field) => {
            const input = INPUTS[field.kind];
            const id = `login-${request.id}-${field.name}`;
            return (
              <Field key={field.name}>
                <FieldLabel htmlFor={id}>{field.label || LOGIN_FIELD_LABELS[field.kind]}</FieldLabel>
                <Input
                  id={id}
                  type={input.type}
                  inputMode={input.inputMode}
                  autoComplete={input.autoComplete}
                  autoCapitalize="off"
                  spellCheck={false}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues((now) => ({ ...now, [field.name]: e.target.value }))}
                />
              </Field>
            );
          })}
          {canRemember ? (
            <FieldLabel htmlFor={`login-${request.id}-remember`}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Remember for next time</FieldTitle>
                  <FieldDescription>The next sign-in to {site} needs no card. Codes are never kept.</FieldDescription>
                </FieldContent>
                <Switch id={`login-${request.id}-remember`} checked={remember} onCheckedChange={setRemember} aria-label="Remember for next time" />
              </Field>
            </FieldLabel>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
      </ActionCard>
    </form>
  );
}
