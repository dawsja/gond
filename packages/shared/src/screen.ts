/**
 * What a bot does on its screen: one batch of these per `computer` (the
 * desktop) or `browser` call, run in order by the box's persistent driver,
 * with one fresh screenshot after the batch. The model only ever writes
 * these; nothing it sends is run as code.
 */
export const SCREEN_STEP_TYPES = [
  "screenshot", "click", "hold", "mouse_down", "mouse_up", "move", "hover", "drag", "type", "type_login", "key", "scroll", "wait", "copy", "paste", "clipboard",
  "navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog", "images",
] as const;
export type ScreenStepType = (typeof SCREEN_STEP_TYPES)[number];
export type ScreenTarget = "desktop" | "browser";
export const BROWSER_ONLY_STEPS: readonly ScreenStepType[] = ["navigate", "back", "forward", "reload", "tab", "new_tab", "close_tab", "fill", "select", "check", "read", "wait_for", "upload", "dialog", "images"];
/** Steps that only look: no approval, and the person holding the mouse doesn't stop them. */
export const LOOK_STEPS: readonly ScreenStepType[] = ["screenshot", "wait", "read", "wait_for", "clipboard", "images"];
export const MAX_SCREEN_STEPS = 20;

export type DesktopControl = "free" | "bots" | "person";

export const DESKTOP_CONTROL_LABELS: Record<DesktopControl, string> = {
  free: "Nobody is driving",
  bots: "A bot is driving",
  person: "You have control",
};

export type DesktopDriver = { botId: string; threadId: string };

/** One bot's screen on the computer: every bot has its own, started when it or the person first needs it. */
export type ScreenState = {
  botId: string;
  running: boolean;
  ready: boolean;
  width: number | null;
  height: number | null;
  viewers: number;
  control: DesktopControl;
};

/** The person's bots' screens that are running, and which conversations have a bot at one. */
export type DesktopState = {
  screens: ScreenState[];
  drivers: DesktopDriver[];
};

/** A bot's screen as the state has it, asleep when it isn't running. */
export function screenOf(desktop: DesktopState | null | undefined, botId: string): ScreenState {
  return desktop?.screens.find((screen) => screen.botId === botId) ?? { botId, running: false, ready: false, width: null, height: null, viewers: 0, control: "free" };
}
