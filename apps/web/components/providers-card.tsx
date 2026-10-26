"use client";

import { KEY_PROVIDER_KINDS, PROVIDER_KINDS, PROVIDER_LABELS, type KeyProviderKind, type ProviderKind, type ProviderMeta } from "@gond/shared";
import { Check, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { api, del, post } from "@/lib/api";
import { cn } from "@/lib/utils";

export function useProviders() {
  const [providers, setProviders] = useState<Record<ProviderKind, ProviderMeta | null> | null>(null);
  const load = useCallback(async () => {
    const data = await api<{ providers: ProviderMeta[] }>("/api/providers").catch(() => null);
    if (!data) return;
    const byKind = Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, data.providers.find((p) => p.kind === kind) ?? null])) as Record<ProviderKind, ProviderMeta | null>;
    setProviders(byKind);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "ai") void load();
  });
  return { providers, reload: load };
}

export function ProviderForm({ kind, provider, onSaved, onCancel }: { kind: ProviderKind; provider: ProviderMeta | null; onSaved: (provider: ProviderMeta) => void; onCancel?: () => void }) {
  const label = PROVIDER_LABELS[kind];
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? label.defaultUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ provider: ProviderMeta }>(`/api/providers/${kind}`, { method: "PUT", body: JSON.stringify({ baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) });
      setApiKey("");
      onSaved(data.provider);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${kind}-key`}>API key</FieldLabel>
          <Input id={`${kind}-key`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider ? "Leave empty to keep the saved key" : label.keyHint} autoComplete="off" spellCheck={false} required={!provider} aria-invalid={error ? true : undefined} />
          <FieldDescription>Never shown again once saved.</FieldDescription>
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${kind}-url`}>Base URL</FieldLabel>
          <Input id={`${kind}-url`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} required />
          <FieldDescription>{kind === "anthropic" ? "Without /v1. Claude Code adds it." : "Up to and including /v1, where the API's /models and /chat/completions live."}</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy} className="pointer-coarse:min-h-11">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "Saving…" : provider ? "Save" : `Save the ${label.short} key`}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} className="pointer-coarse:min-h-11">
              Cancel
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}

export function ProviderCheck({ provider }: { provider: ProviderMeta }) {
  if (!provider.check) return <span className="text-[12.5px] text-muted-foreground">Not checked yet.</span>;
  return (
    <span className={provider.check.ok ? "flex items-center gap-1.5 text-[12.5px] text-muted-foreground" : "flex items-center gap-1.5 text-[12.5px] text-destructive"}>
      {provider.check.ok ? <Check className="size-3.5 text-mint" aria-hidden="true" /> : <TriangleAlert className="size-3.5" aria-hidden="true" />}
      {provider.check.detail}
    </span>
  );
}

/** A saved key's own actions: change it, check it, or remove it. */
function ManageKey({ kind, provider, onChange }: { kind: KeyProviderKind; provider: ProviderMeta; onChange: () => void }) {
  const label = PROVIDER_LABELS[kind];
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function check() {
    setChecking(true);
    await post(`/api/providers/${kind}/check`).catch(() => undefined);
    setChecking(false);
    onChange();
  }

  return (
    <div className="flex flex-col gap-3">
      {editing ? (
        <ProviderForm
          kind={kind}
          provider={provider}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setEditing(true)}>
            Change the key
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={checking} onClick={() => void check()}>
            {checking ? <Spinner data-icon="inline-start" /> : null}
            Check
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11 text-destructive" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      )}
      <Confirm
        open={removing}
        onOpenChange={setRemoving}
        title="Remove this API key?"
        description={`Bots running on the ${label.short} API stop working until you add a key again or pick somewhere else for them to run.`}
        action="Remove"
        onConfirm={async () => {
          await del(`/api/providers/${kind}`);
          await onChange();
        }}
      />
    </div>
  );
}

/** Step 2 for the API engine: one row per API, the saved ones to pick between, the rest to add. */
export function KeyList({
  providers,
  only,
  chosen,
  onPick,
  onChange,
}: {
  providers: Record<ProviderKind, ProviderMeta | null>;
  /** The APIs the engine can run on, when it is fewer than all of them. */
  only?: readonly KeyProviderKind[];
  chosen: ProviderKind;
  onPick: (kind: KeyProviderKind) => void;
  onChange: () => void;
}) {
  const [open, setOpen] = useState<KeyProviderKind | null>(null);
  const kinds = only ?? KEY_PROVIDER_KINDS;
  const saved = kinds.filter((kind) => providers[kind]);

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup aria-label="Which key" value={saved.includes(chosen as KeyProviderKind) ? chosen : null} onValueChange={(value) => typeof value === "string" && onPick(value as KeyProviderKind)} className="gap-0 overflow-hidden rounded-2xl border">
        {kinds.map((kind, index) => {
          const provider = providers[kind];
          const label = PROVIDER_LABELS[kind];
          const expanded = open === kind;
          return (
            <div key={kind} className={cn("flex flex-col gap-3 p-3 pl-4", index > 0 && "border-t")}>
              <div className="flex min-h-11 items-center gap-3">
                <RadioGroupItem value={kind} id={`key-${kind}`} disabled={!provider} aria-label={label.name} />
                <label htmlFor={`key-${kind}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn("text-[14px] font-medium", !provider && "text-muted-foreground")}>{label.name}</span>
                  {provider ? (
                    <>
                      <code className="truncate font-mono text-[12px] text-muted-foreground">{provider.baseUrl}</code>
                      <ProviderCheck provider={provider} />
                    </>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">{label.detail}</span>
                  )}
                </label>
                <Button variant={provider ? "ghost" : "outline"} size="sm" className="pointer-coarse:min-h-11" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : kind)}>
                  {provider ? (expanded ? "Done" : "Manage") : expanded ? "Cancel" : "Add key"}
                </Button>
              </div>
              {expanded && provider ? <ManageKey kind={kind} provider={provider} onChange={onChange} /> : null}
              {expanded && !provider ? (
                <ProviderForm
                  kind={kind}
                  provider={null}
                  onSaved={() => {
                    setOpen(null);
                    onChange();
                    onPick(kind);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </RadioGroup>
      <p className="text-[12.5px] text-muted-foreground">You pay the provider for what your bots use. Keys are kept encrypted here and never reach the computer.</p>
    </div>
  );
}

export function AddProviderKey({ providers, onSaved }: { providers: Record<ProviderKind, ProviderMeta | null>; onSaved: (kind: ProviderKind) => void }) {
  const missing = KEY_PROVIDER_KINDS.filter((kind) => !providers[kind]);
  const [picked, setPicked] = useState<KeyProviderKind | null>(null);

  const kind = picked && !providers[picked] ? picked : null;
  if (!missing.length) return null;

  return (
    <FieldGroup className="gap-3">
      <Field>
        <FieldTitle>Add an API key</FieldTitle>
        <Select items={missing.map((k) => ({ value: k, label: PROVIDER_LABELS[k].name }))} value={kind ?? ""} onValueChange={(value) => value && setPicked(value as KeyProviderKind)}>
          <SelectTrigger className="w-full max-w-sm" aria-label="Which API">
            <SelectValue placeholder="Which API?" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {missing.map((k) => (
                <SelectItem key={k} value={k}>
                  {PROVIDER_LABELS[k].name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {kind ? <FieldDescription>{PROVIDER_LABELS[kind].detail}</FieldDescription> : null}
      </Field>
      {kind ? (
        <div className="rounded-xl border p-4">
          <ProviderForm
            kind={kind}
            provider={null}
            onSaved={() => {
              setPicked(null);
              onSaved(kind);
            }}
            onCancel={() => setPicked(null)}
          />
        </div>
      ) : null}
    </FieldGroup>
  );
}
