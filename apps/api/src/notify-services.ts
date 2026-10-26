import { NOTIFY_SERVICES, type NotifyServiceKind } from "@gond/shared";
import { appUrl } from "./config.ts";
import { readNotifyService, recordNotifyResult, type StoredService } from "./data/notify-services.ts";

const SEND_TIMEOUT_MS = 10_000;

export type Notice = { title: string; body: string; url: string };

type Checked = { settings: Record<string, string>; secrets: Record<string, string> } | { error: string };

const httpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * What the person typed for a service, checked and split into what may be shown and what is kept
 * secret. A secret left empty keeps the one saved for the same service, so editing never means
 * typing every key again.
 */
export function checkService(kind: NotifyServiceKind, values: Record<string, unknown>, existing: StoredService | null): Checked {
  const service = NOTIFY_SERVICES[kind];
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of service.fields) {
    const raw = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (field.secret) {
      const kept = existing?.kind === kind ? existing.secrets[field.key] : undefined;
      const value = raw || kept || "";
      if (!value && !field.optional) return { error: `Enter the ${field.label.toLowerCase()}.` };
      if (value) secrets[field.key] = value;
      continue;
    }
    const value = raw || field.initial || "";
    if (!value && !field.optional) return { error: `Enter the ${field.label.toLowerCase()}.` };
    if (field.options && !field.options.some((o) => o.value === value)) return { error: `Pick a ${field.label.toLowerCase()} from the list.` };
    if (value) settings[field.key] = value;
  }
  const problem = shapeProblem(kind, settings, secrets);
  if (problem) return { error: problem };
  if (settings.server) settings.server = settings.server.replace(/\/+$/, "");
  return { settings, secrets };
}

function shapeProblem(kind: NotifyServiceKind, settings: Record<string, string>, secrets: Record<string, string>): string | null {
  if (settings.server && !httpUrl(settings.server)) return "The server's address has to start with https:// or http://.";
  switch (kind) {
    case "ntfy":
      return /^[-\w]{1,64}$/.test(settings.topic ?? "") ? null : "A topic is letters, numbers, dashes and underscores, up to 64 of them.";
    case "pushover":
      return /^\w{30}$/.test(secrets.user ?? "") && /^\w{30}$/.test(secrets.token ?? "") ? null : "Pushover's user key and application token are 30 letters and numbers each.";
    case "discord": {
      const url = httpUrl(secrets.url ?? "");
      const discord = url && url.protocol === "https:" && /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(url.hostname) && url.pathname.startsWith("/api/webhooks/");
      return discord ? null : "That isn't a Discord webhook URL. Copy it from the channel's Webhooks settings.";
    }
    case "telegram":
      if (!/^\d+:[\w-]{30,}$/.test(secrets.token ?? "")) return "That doesn't look like a bot token from @BotFather.";
      return /^(?:-?\d+|@\w{5,})$/.test(settings.chat ?? "") ? null : "A chat ID is a number, like 123456789, or a channel's @name.";
    case "webhook":
      return httpUrl(secrets.url ?? "") ? null : "The URL has to start with https:// or http://.";
    default:
      return null;
  }
}

/** Sends one notice to the service, or throws with what went wrong in words the person can act on. */
export async function deliver(service: Pick<StoredService, "kind" | "settings" | "secrets">, notice: Notice, signal = AbortSignal.timeout(SEND_TIMEOUT_MS)): Promise<void> {
  const { kind, settings, secrets } = service;
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = `${notice.title}\n${notice.body}`;
  switch (kind) {
    case "ntfy":
      return post(kind, `${settings.server}/`, json({ topic: settings.topic, title: notice.title, message: notice.body, click: notice.url, priority: Number(settings.priority ?? 3) }, secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {}), signal);
    case "pushover":
      return post(
        kind,
        "https://api.pushover.net/1/messages.json",
        { method: "POST", body: new URLSearchParams({ token: secrets.token ?? "", user: secrets.user ?? "", title: notice.title.slice(0, 250), message: notice.body.slice(0, 1024) || notice.title, url: notice.url, url_title: "Open in Gond", priority: settings.priority ?? "0" }) },
        signal,
      );
    case "discord":
      return post(kind, secrets.url ?? "", json({ username: "Gond", content: `**${notice.title}**\n${notice.body}\n${notice.url}`.slice(0, 2000), allowed_mentions: { parse: [] } }), signal);
    case "telegram":
      return post(kind, `https://api.telegram.org/bot${secrets.token}/sendMessage`, json({ chat_id: settings.chat, text: `${text}\n${notice.url}`.slice(0, 4096), disable_web_page_preview: true }), signal);
    case "gotify":
      return post(kind, `${settings.server}/message`, json({ title: notice.title, message: notice.body || notice.title, priority: Number(settings.priority ?? 5), extras: { "client::notification": { click: { url: notice.url } } } }, { "X-Gotify-Key": secrets.token ?? "" }), signal);
    case "webhook":
      return post(kind, secrets.url ?? "", json({ title: notice.title, body: notice.body, url: notice.url, sentAt: new Date().toISOString() }), signal);
  }
}

async function post(kind: NotifyServiceKind, url: string, init: RequestInit, signal: AbortSignal): Promise<void> {
  const name = NOTIFY_SERVICES[kind].name;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch {
    throw new Error(`Couldn't reach ${name}. Check the address, and that it's running.`);
  }
  if (res.ok) return;
  const said = await res.text().then(saidBy).catch(() => null);
  if (res.status === 401 || res.status === 403) throw new Error(`${name} turned the key down${said ? `: ${said}` : ""}. Check it and save again.`);
  if (res.status === 404) throw new Error(`${name} couldn't find where to send it${said ? `: ${said}` : ""}. Check the address.`);
  if (res.status === 429) throw new Error(`${name} is sending too much right now. It'll go through again shortly.`);
  throw new Error(said ? `${name} said: ${said}` : `${name} didn't take it. Try again.`);
}

/** The reason a service gives in its error body, short: Pushover's errors, Telegram's description, Discord's message. */
function saidBy(text: string): string | null {
  try {
    const body = JSON.parse(text) as { errors?: unknown; description?: unknown; message?: unknown; error?: unknown };
    const reason = Array.isArray(body.errors) ? body.errors.join(" ") : (body.description ?? body.message ?? body.error);
    return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** A notice for the person's service, when they have one switched on; how it went is kept for Settings. */
export async function notifyService(userId: string, notice: { title: string; body: string; url: string }): Promise<void> {
  const service = readNotifyService(userId);
  if (!service?.enabled) return;
  try {
    await deliver(service, { ...notice, url: linkTo(notice.url) });
    recordNotifyResult(userId, null);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "It didn't go through.";
    recordNotifyResult(userId, reason);
    console.warn(`[gond] couldn't notify ${userId} through ${NOTIFY_SERVICES[service.kind].name}: ${reason}`);
  }
}

/** A path on this Gond as the address a phone opens. */
export function linkTo(path: string): string {
  return new URL(path || "/app", appUrl()).toString();
}
