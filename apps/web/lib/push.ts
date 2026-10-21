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
  await post("/api/push/subscriptions", { ...subscription.toJSON(), device: deviceId() });
}

let device: string | null = null;

/** One id per browser or app install, kept across reloads, so the API can notify only the one the person used last. */
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

export function deviceId(): string {
  if (device) return device;
  try {
    device = localStorage.getItem("gond-device");
    if (!device) {
      device = crypto.randomUUID();
      localStorage.setItem("gond-device", device);
    }
  } catch {
    device ??= crypto.randomUUID();
  }
  return device;
}

/** A subscription made before devices were recorded gets its device on the next visit. */
export async function tagSubscription(): Promise<void> {
  if (pushPermission() !== "granted") return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await post("/api/push/subscriptions", { ...subscription.toJSON(), device: deviceId() }).catch(() => undefined);
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => undefined);
  await subscription.unsubscribe();
}
