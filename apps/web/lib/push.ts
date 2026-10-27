import { ALL_NOTICES, readDeviceNotices, type DeviceNotices } from "@gond/shared";
import { api, post } from "@/lib/api";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushPermission(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

function toKey(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("This browser can't receive push notifications here. Push needs https (or localhost).");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings and try again.");
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
  await post("/api/push/subscriptions", subscription.toJSON());
}

// The apps can't take back the system's permission, so their Turn off is a switch kept on this device.
const SHELL_OFF = "gond-shell-notifications-off";

export function shellNotificationsOff(): boolean {
  try {
    return localStorage.getItem(SHELL_OFF) === "1";
  } catch {
    return false;
  }
}

export function setShellNotificationsOff(off: boolean) {
  try {
    if (off) localStorage.setItem(SHELL_OFF, "1");
    else localStorage.removeItem(SHELL_OFF);
  } catch {}
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => undefined);
  await subscription.unsubscribe();
}

// The apps get notices as live events rather than Web Push, so which bots this one hears about is kept on it.
const SHELL_NOTICES = "gond-shell-notices";

export function shellNotices(): DeviceNotices {
  try {
    const raw = localStorage.getItem(SHELL_NOTICES);
    return (raw ? readDeviceNotices(JSON.parse(raw)) : null) ?? ALL_NOTICES;
  } catch {
    return ALL_NOTICES;
  }
}

function setShellNotices(notices: DeviceNotices) {
  try {
    localStorage.setItem(SHELL_NOTICES, JSON.stringify(notices));
  } catch {}
}

/** What this browser or app is told about; null when this browser has no subscription to choose for. */
export async function deviceNotices(inShell: boolean): Promise<DeviceNotices | null> {
  if (inShell) return shellNotices();
  const subscription = await currentSubscription();
  if (!subscription) return null;
  return (await post<{ notices: DeviceNotices }>("/api/push/notices", { endpoint: subscription.endpoint })).notices;
}

export async function saveDeviceNotices(inShell: boolean, notices: DeviceNotices): Promise<void> {
  if (inShell) return setShellNotices(notices);
  const subscription = await currentSubscription();
  if (!subscription) throw new Error("Notifications aren't on for this browser. Turn them on first.");
  await api("/api/push/notices", { method: "PUT", body: JSON.stringify({ endpoint: subscription.endpoint, notices }) });
}
