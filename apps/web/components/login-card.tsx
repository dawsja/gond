"use client";

import { LOGIN_FIELD_LABELS, type Bot, type LoginField, type SecretRequest } from "@gond/shared";
import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ActionCard } from "@/components/action-card";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
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

  return (
    <ActionCard icon={<LogIn className="size-3.5" aria-hidden="true" />} title={`${bot?.name ?? "A bot"} is signing you in to ${site}`}>
      {request.reason ? <p className="text-[13.5px] text-muted-foreground">{request.reason}</p> : null}
      {request.status === "pending" ? (
        <form onSubmit={answer} className="flex flex-col gap-3">
          <FieldGroup className="max-w-sm gap-3">
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
                    <FieldDescription>Stored encrypted, so the next sign-in to {site} needs no card. Codes are never kept.</FieldDescription>
                  </FieldContent>
                  <Switch id={`login-${request.id}-remember`} checked={remember} onCheckedChange={setRemember} aria-label="Remember for next time" />
                </Field>
              </FieldLabel>
            ) : null}
          </FieldGroup>
          {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || !filled}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Sign in
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(undefined, true)}>
              Not now
            </Button>
          </div>
          <p className="text-[11.5px] text-muted-foreground">Typed straight into the page by the API. The bot never sees it, and it stays out of the chat.</p>
        </form>
      ) : (
        <p className="text-[12px] text-muted-foreground">{request.status === "given" ? "Sent. The bot is signing in." : request.status === "declined" ? "Not now." : "Nobody answered in time."}</p>
      )}
    </ActionCard>
  );
}
