"use client";

import { NOTIFY_SERVICE_KINDS, NOTIFY_SERVICES, type NotifyService, type NotifyServiceKind } from "@gond/shared";
import { Ellipsis, Globe, Monitor, Pencil, Send, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { failed } from "@/components/failed";
import { LoadFailed } from "@/components/load-failed";
import { Confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useHeld } from "@/hooks/use-held";
import { api, del, patch, post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported, setShellNotificationsOff, shellNotificationsOff } from "@/lib/push";
import { isPhoneShell, shellBridge, useNativeShell } from "@/lib/shell";

const NOTIFICATIONS_EVENT = "gond:notifications";

/** Settings → Notifications: everywhere a notice goes, and the one service (ntfy, Pushover and the rest) a person can add. */
export function NotificationsSection() {
  const [service, setService] = useState<NotifyService | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const shownName = useHeld(service ? NOTIFY_SERVICES[service.kind].name : "", removing);

  const load = useCallback(async () => {
    try {
      const data = await api<{ service: NotifyService | null }>("/api/notify-service");
      setService(data.service);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Where notices go</CardTitle>
          <CardDescription>Everywhere on this list gets every notice when a bot finishes or needs you, except about the conversation you have open. Each bot also has its own switch in its profile.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y">
            <DeviceRow />
            {service ? <ServiceRow service={service} onChange={setService} onEdit={() => setEditing(true)} onRemove={() => setRemoving(true)} /> : null}
          </ul>
          {loadFailed ? <LoadFailed what="your notification service" onRetry={() => void load()} /> : null}
        </CardContent>
      </Card>

      {service !== undefined && (!service || editing) ? (
        <ServiceForm
          key={editing ? "edit" : "add"}
          current={service}
          editing={editing}
          onSaved={(saved) => {
            setService(saved);
            setEditing(false);
          }}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
      ) : null}

      <Confirm
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${shownName}?`}
        description={`Notices stop going to ${shownName}, and its keys are forgotten. Your browsers and apps keep getting theirs.`}
        action="Remove"
        cancel="Keep it"
        onConfirm={async () => {
          await del("/api/notify-service");
          setService(null);
          setEditing(false);
        }}
      />
    </>
  );
}

type DeviceState = "checking" | "unsupported" | "off" | "on" | "blocked";

/** This browser or app: on or off for it alone, since the system's permission is per device. */
function DeviceRow() {
  const shell = useNativeShell();
  const [state, setState] = useState<DeviceState>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = async () => {
      const bridge = shellBridge();
      if (bridge) {
        if (typeof bridge.notificationsState !== "function") return setState("unsupported");
        const permission = await bridge.notificationsState();
        return setState(permission === "granted" ? (shellNotificationsOff() ? "off" : "on") : permission === "denied" ? "blocked" : "off");
      }
      if (!pushSupported()) return setState("unsupported");
      if (pushPermission() === "denied") return setState("blocked");
      setState((await currentSubscription()) ? "on" : "off");
    };
    void Promise.resolve().then(read);
    const onChange = () => void read();
    window.addEventListener(NOTIFICATIONS_EVENT, onChange);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onChange);
  }, []);

  async function turnOn() {
    const bridge = shellBridge();
    if (bridge) {
      setShellNotificationsOff(false);
      const granted = typeof bridge.notificationsState === "function" && (await bridge.notificationsState()) === "granted";
      if (!granted && typeof bridge.requestNotifications === "function") await bridge.requestNotifications();
      return void window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    }
    setBusy(true);
    try {
      await enablePush();
      setState("on");
    } catch (failure) {
      if (pushPermission() === "denied") setState("blocked");
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't turn notifications on." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    const bridge = shellBridge();
    if (bridge) {
      setShellNotificationsOff(true);
      return void window.dispatchEvent(new Event(NOTIFICATIONS_EVENT));
    }
    setBusy(true);
    try {
      await disablePush();
      setState("off");
    } catch (failure) {
      failed("Couldn't turn notifications off.")(failure);
    } finally {
      setBusy(false);
    }
  }

  const phone = isPhoneShell(shell);
  const name = phone ? "This phone" : shell === "desktop" ? "This computer" : "This browser";
  const Icon = phone ? Smartphone : shell === "desktop" ? Monitor : Globe;
  const detail =
    state === "checking"
      ? "Checking…"
      : state === "on"
        ? phone
          ? "On, while the Gond app is open or just put away."
          : shell === "desktop"
            ? "On, while the Gond app is running."
            : "On for this browser."
        : state === "off"
          ? "Off here."
          : state === "blocked"
            ? phone
              ? "Notifications are off for Gond in the phone's settings. Turning this on opens them."
              : shell
                ? "Notifications are off for Gond in the computer's settings. Allow them there, then try again."
                : "The browser blocks notifications for this site. Allow them in its site settings, then try again."
            : shell
              ? "This version of the app can't show notifications. Update it."
              : "This browser can't get notifications from this address: it needs https.";
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium">{name}</p>
        <p className="text-[13px] text-muted-foreground">{detail}</p>
      </div>
      {busy ? <Spinner /> : null}
      <Switch
        size="sm"
        checked={state === "on"}
        disabled={busy || state === "checking" || state === "unsupported" || (state === "blocked" && !phone)}
        onCheckedChange={(on) => void (on ? turnOn() : turnOff())}
        aria-label={`Notifications for ${name.toLowerCase()}`}
      />
    </li>
  );
}

function ServiceMark({ kind, small = false }: { kind: NotifyServiceKind; small?: boolean }) {
  const service = NOTIFY_SERVICES[kind];
  const letter = kind === "webhook" ? "{}" : service.name[0]!.toUpperCase();
  return (
    <span aria-hidden="true" className={small ? "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white" : "grid size-9 shrink-0 place-items-center rounded-xl text-[14px] font-bold text-white"} style={{ backgroundColor: service.color }}>
      {kind === "ntfy" ? "n" : letter}
    </span>
  );
}

function hostOf(address: string | undefined): string {
  try {
    return address ? new URL(address).host : "";
  } catch {
    return address ?? "";
  }
}

/** What the row says about where notices go, from what isn't secret. */
function summary(service: NotifyService): string {
  const { kind, details } = service;
  switch (kind) {
    case "ntfy":
      return `${hostOf(details.server)} · topic ${details.topic ?? ""}`;
    case "pushover":
      return "Your devices in the Pushover app";
    case "discord":
      return "A Discord channel, by its webhook";
    case "telegram":
      return `Chat ${details.chat ?? ""}`;
    case "gotify":
      return hostOf(details.server);
    case "webhook":
      return "Your webhook, as JSON";
  }
}

function ServiceRow({ service, onChange, onEdit, onRemove }: { service: NotifyService; onChange: (service: NotifyService) => void; onEdit: () => void; onRemove: () => void }) {
  const name = NOTIFY_SERVICES[service.kind].name;
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    try {
      await post("/api/notify-service/test");
      toast.add({ type: "success", title: `Sent. Check ${name}.` });
    } catch (failure) {
      failed("The test didn't go through.")(failure);
    } finally {
      setTesting(false);
    }
  }

  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <ServiceMark kind={service.kind} />
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium">{name}</p>
        <p className="truncate text-[13px] text-muted-foreground">{summary(service)}</p>
        {service.lastError ? (
          <p className="text-[12.5px] text-destructive">{service.lastError}</p>
        ) : service.lastSentAt ? (
          <p className="text-[12.5px] text-muted-foreground">Last sent {new Date(service.lastSentAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
        ) : null}
      </div>
      {testing ? <Spinner /> : null}
      <Switch
        size="sm"
        checked={service.enabled}
        onCheckedChange={(on) => void patch<{ service: NotifyService }>("/api/notify-service", { enabled: on }).then((data) => onChange(data.service)).catch(failed(on ? `Couldn't turn ${name} on.` : `Couldn't turn ${name} off.`))}
        aria-label={`Notifications through ${name}`}
      />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${name} options`} />}>
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => void test()}>
              <Send aria-hidden="true" />
              Send a test
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Change
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 aria-hidden="true" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function startingValues(kind: NotifyServiceKind, current: NotifyService | null): Record<string, string> {
  const same = current?.kind === kind;
  return Object.fromEntries(NOTIFY_SERVICES[kind].fields.map((field) => [field.key, field.secret ? "" : same ? (current?.details[field.key] ?? field.initial ?? "") : (field.initial ?? "")]));
}

/** Adding the one service, or changing it: pick from the list, fill in what it needs, try it, save. */
function ServiceForm({ current, editing, onSaved, onCancel }: { current: NotifyService | null; editing: boolean; onSaved: (service: NotifyService) => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<NotifyServiceKind>(current?.kind ?? "ntfy");
  const [values, setValues] = useState(() => startingValues(current?.kind ?? "ntfy", current));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = NOTIFY_SERVICES[kind];
  const same = current?.kind === kind;

  function pick(next: NotifyServiceKind) {
    setKind(next);
    setValues(startingValues(next, current));
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const data = await api<{ service: NotifyService }>("/api/notify-service", { method: "PUT", body: JSON.stringify({ kind, values }) });
      toast.add({ type: "success", title: editing ? `${spec.name} is saved.` : `Notices go to ${spec.name} now.` });
      onSaved(data.service);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save it. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setError(null);
    try {
      await post("/api/notify-service/test", { kind, values });
      toast.add({ type: "success", title: `Sent. Check ${spec.name}.` });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The test didn't go through.");
    } finally {
      setTesting(false);
    }
  }

  const title = editing && current ? `Change ${NOTIFY_SERVICES[current.kind].name}` : "Add a service";
  const description = editing && current
    ? same
      ? "Leave a key empty to keep the one that's saved."
      : `Picking another service replaces ${NOTIFY_SERVICES[current.kind].name}: one service at a time for now. Your browsers and apps keep getting theirs.`
    : "Send notices to an app on your phone, a chat, or anything that takes a webhook, as well as to your browsers and apps. One service at a time for now.";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="notify-service">Service</FieldLabel>
              <Select items={NOTIFY_SERVICE_KINDS.map((k) => ({ value: k, label: NOTIFY_SERVICES[k].name }))} value={kind} onValueChange={(value) => value && pick(value as NotifyServiceKind)}>
                <SelectTrigger id="notify-service" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {NOTIFY_SERVICE_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        <ServiceMark kind={k} small />
                        {NOTIFY_SERVICES[k].name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{spec.blurb}</FieldDescription>
            </Field>
            <div className="grid gap-5 wide:grid-cols-2">
              {spec.fields.map((field) => {
                const id = `notify-${field.key}`;
                const kept = field.secret && same && current?.saved.includes(field.key);
                return (
                  <Field key={`${kind}-${field.key}`} className={spec.fields.length === 1 || field.help ? "wide:col-span-2" : undefined}>
                    <FieldLabel htmlFor={id}>
                      {field.label}
                      {field.optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
                    </FieldLabel>
                    {field.options ? (
                      <Select items={field.options.map((o) => ({ value: o.value, label: o.label }))} value={values[field.key] ?? field.initial ?? ""} onValueChange={(value) => value && setValues((now) => ({ ...now, [field.key]: value }))}>
                        <SelectTrigger id={id} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {field.options.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={id}
                        type={field.secret ? "password" : "text"}
                        inputMode={field.key === "server" || field.key === "url" ? "url" : undefined}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder={kept ? "Saved. Leave empty to keep it." : field.placeholder}
                        value={values[field.key] ?? ""}
                        onChange={(e) => setValues((now) => ({ ...now, [field.key]: e.target.value }))}
                      />
                    )}
                    {field.help ? <FieldDescription>{field.help}</FieldDescription> : null}
                  </Field>
                );
              })}
            </div>
            {error ? <FieldError>{error}</FieldError> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="tint" disabled={saving}>
                {saving ? <Spinner data-icon="inline-start" /> : null}
                {editing ? "Save" : `Add ${spec.name}`}
              </Button>
              <Button type="button" variant="outline" disabled={testing} onClick={() => void test()}>
                {testing ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" aria-hidden="true" />}
                Send a test
              </Button>
              {onCancel ? (
                <Button type="button" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
