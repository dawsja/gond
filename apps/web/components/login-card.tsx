"use client";

import { coverLogin, LOGIN_FIELD_LABELS, type Bot, type LoginField, type SecretMeta, type SecretRequest } from "@gond/shared";
import { LogIn } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ActionCard, ActionCardDone, cheerOnFold, NOBODY_ANSWERED } from "@/components/action-card";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { apiShared, post } from "@/lib/api";

const INPUTS: Record<LoginField["kind"], { type: string; autoComplete: string; inputMode?: "email" | "tel" | "numeric" }> = {
  email: { type: "email", autoComplete: "off", inputMode: "email" },
  username: { type: "text", autoComplete: "off" },
  phone: { type: "tel", autoComplete: "off", inputMode: "tel" },
  password: { type: "password", autoComplete: "off" },
  code: { type: "text", autoComplete: "one-time-code", inputMode: "numeric" },
};

const TYPE_IT = "type";

/** The person's saved sign-ins, by site, newest first, each with the fields of this card it fills. */
function useSavedLogins(fields: LoginField[], pending: boolean) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    // Without the list the card still works by typing, so a failed load only hides the picker.
    apiShared<{ secrets: SecretMeta[] }>("/api/secrets")
      .then((data) => live && setSecrets(data.secrets))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pending]);
  const sites = new Map<string, { names: string[]; newest: string }>();
  for (const secret of secrets) {
    if (!secret.site) continue;
    const entry = sites.get(secret.site) ?? { names: [], newest: "" };
    entry.names.push(secret.name);
    if (secret.updatedAt > entry.newest) entry.newest = secret.updatedAt;
    sites.set(secret.site, entry);
  }
  return [...sites.entries()]
    .map(([site, { names, newest }]) => ({ site, newest, fills: new Set(coverLogin(fields, names).keys()) }))
    .filter((saved) => saved.fills.size > 0)
    .sort((a, b) => b.newest.localeCompare(a.newest));
}

export function LoginCard({ request, bot, onAnswered }: { request: SecretRequest; bot: Bot | undefined; onAnswered: (request: SecretRequest) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const savedLogins = useSavedLogins(request.fields, request.status === "pending");
  const saved = savedLogins.find((s) => s.site === picked) ?? null;
  const site = request.site ?? request.name;
  const toType = request.fields.filter((field) => !saved?.fills.has(field.name));
  const canRemember = toType.some((field) => field.kind !== "code");
  const filled = toType.every((field) => values[field.name]);

  async function answer(event?: FormEvent, decline = false) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ request: SecretRequest }>(`/api/secret-requests/${request.id}`, decline ? { decline: true } : { values, saved: saved?.site, remember: canRemember && remember });
      setValues({});
      if (!decline) cheerOnFold(request.id);
      onAnswered(data.request);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't send it.");
    } finally {
      setBusy(false);
    }
  }

  const name = bot?.name ?? "A bot";
  const icon = <LogIn aria-hidden="true" />;
  if (request.status !== "pending") {
    const done = request.status === "given" ? { status: "Sent", tone: "ok" as const } : request.status === "declined" ? { status: "Not now", tone: "neutral" as const } : { status: "Expired", tone: "neutral" as const };
    return <ActionCardDone id={request.id} bot={bot} icon={icon} title={`Sign in to ${site}`} by={request.status === "expired" ? NOBODY_ANSWERED : name} status={done.status} tone={done.tone} />;
  }

  return (
    <form onSubmit={answer} className="contents">
      <ActionCard
        icon={icon}
        title={`Sign in to ${site}`}
        by={request.reason || `${name} is on the sign-in page`}
        actions={
          <>
            <Button type="submit" size="xl" variant="tint" className="w-full" disabled={busy || !filled}>
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
          {savedLogins.length ? (
            <Field>
              <FieldLabel htmlFor={`login-${request.id}-saved`}>Use a saved sign-in</FieldLabel>
              <Select
                items={[{ value: TYPE_IT, label: "None, I'll type it" }, ...savedLogins.map((s) => ({ value: s.site, label: s.site }))]}
                value={saved?.site ?? TYPE_IT}
                onValueChange={(value) => setPicked(value && value !== TYPE_IT ? value : null)}
              >
                <SelectTrigger id={`login-${request.id}-saved`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={TYPE_IT}>None, I&apos;ll type it</SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    {savedLogins.map((s) => (
                      <SelectItem key={s.site} value={s.site}>
                        {s.site}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {saved ? <FieldDescription>Gond fills in {fillsLine(request.fields.filter((field) => saved.fills.has(field.name)))} from it.</FieldDescription> : null}
            </Field>
          ) : null}
          {toType.map((field) => {
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

function fillsLine(fields: LoginField[]): string {
  const words = fields.map((field) => (field.label || LOGIN_FIELD_LABELS[field.kind]).toLowerCase());
  const named = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
  return `the ${named}`;
}
