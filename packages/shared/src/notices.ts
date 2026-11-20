export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** What one browser or app is told about: every bot but the muted ones, and `other` for notices about no bot (exports, spaces). */
export type DeviceNotices = { mutedBots: string[]; other: boolean };

export const ALL_NOTICES: DeviceNotices = { mutedBots: [], other: true };

/** Whether a device that chose `notices` gets a notice about `botId` (null: about no bot). */
export function noticeWanted(notices: DeviceNotices, botId: string | null | undefined): boolean {
  return botId ? !notices.mutedBots.includes(botId) : notices.other;
}

export function readDeviceNotices(value: unknown): DeviceNotices | null {
  if (!value || typeof value !== "object") return null;
  const { mutedBots, other } = value as { mutedBots?: unknown; other?: unknown };
  if (!Array.isArray(mutedBots) || mutedBots.length > 500 || !mutedBots.every((id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id))) return null;
  if (typeof other !== "boolean") return null;
  return { mutedBots: [...new Set(mutedBots as string[])], other };
}
