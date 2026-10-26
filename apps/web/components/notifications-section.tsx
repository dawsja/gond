"use client";

import { NOTIFY_SERVICE_KINDS, NOTIFY_SERVICES, type NotifyService, type NotifyServiceKind } from "@gond/shared";
import { Ellipsis, Globe, Monitor, Pencil, Send, Smartphone, Trash2, Webhook } from "lucide-react";
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
import { cn } from "@/lib/utils";

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

// Each service's own mark, white on its color: ntfy's, Discord's and Telegram's from Simple Icons (CC0), Pushover's P from its icon.
const MARKS: Partial<Record<NotifyServiceKind, { viewBox: string; d: string }>> = {
  ntfy: { viewBox: "0 0 24 24", d: "M12.597 13.693v2.156h6.205v-2.156ZM5.183 6.549v2.363l3.591 1.901.023.01-.023.009-3.591 1.901v2.35l.386-.211 5.456-2.969V9.729ZM3.659 2.037C1.915 2.037.42 3.41.42 5.154v.002L.438 18.73 0 21.963l5.956-1.583h14.806c1.744 0 3.238-1.374 3.238-3.118V5.154c0-1.744-1.493-3.116-3.237-3.117h-.001zm0 2.2h17.104c.613.001 1.037.447 1.037.917v12.108c0 .47-.424.916-1.038.916H5.633l-3.026.915.031-.179-.017-13.76c0-.47.424-.917 1.038-.917z" },
  pushover: { viewBox: "70 70 372 372", d: "m240.7 147.2 64.2-8.5-62.5 141.1c11-.8 21.8-4.6 32.3-11.2 10.6-6.6 20.3-14.9 29.2-24.9s16.5-21.1 23-33.4 11.1-24.3 13.9-36.1c1.7-7.3 2.5-14.4 2.3-21.1-.1-6.8-1.9-12.7-5.3-17.7-3.4-5.1-8.5-9.2-15.4-12.3s-16.3-4.6-28.1-4.6c-13.8 0-27.4 2.3-40.8 6.8s-25.8 11.1-37.2 19.7-21.3 19.3-29.8 32.1-14.5 27.4-18.2 43.7c-1.4 5.4-2.3 9.6-2.5 12.9-.3 3.2-.4 5.9-.2 8 .1 2.1.4 3.7.8 4.9.4 1.1.8 2.3 1.1 3.4q-21.6 0-31.5-8.7c-6.6-5.8-8.2-15.8-4.9-30.2 3.4-14.9 11.1-29.2 23-42.7 12-13.5 26.2-25.4 42.7-35.7s34.5-18.4 54.1-24.5 38.7-9.1 57.3-9.1c16.3 0 30.1 2.3 41.2 7s19.8 10.8 26 18.4 10.1 16.5 11.6 26.6c1.6 10.1 1.1 20.7-1.5 31.7-3.1 13.2-8.9 26.6-17.5 39.9-8.6 13.4-19.4 25.5-32.3 36.3-13 10.8-27.8 19.6-44.6 26.4s-34.6 10.1-53.4 10.1h-2.1L182 415.9h-60.8z" },
  discord: { viewBox: "0 0 24 24", d: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" },
  telegram: { viewBox: "0 0 24 24", d: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" },
};

function ServiceMark({ kind, small = false }: { kind: NotifyServiceKind; small?: boolean }) {
  const service = NOTIFY_SERVICES[kind];
  const mark = MARKS[kind];
  const tile = small ? "grid size-5 shrink-0 place-items-center overflow-hidden rounded-md" : "grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl";
  // Gotify's gopher only reads in its own colors, so it keeps its white ground (CC BY 4.0, the Gotify organisation).
  if (kind === "gotify") {
    return (
      <span aria-hidden="true" className={cn(tile, "border bg-white")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/services/gotify.svg" alt="" className="size-full" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn(tile, "text-white")} style={{ backgroundColor: service.color }}>
      {mark ? (
        <svg viewBox={mark.viewBox} fill="currentColor" aria-hidden="true" className={small ? "size-3" : "size-5"}>
          <path d={mark.d} />
        </svg>
      ) : (
        <Webhook aria-hidden="true" className={small ? "size-3" : "size-5"} />
      )}
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
