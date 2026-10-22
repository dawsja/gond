"use client";

import type RFB from "@novnc/novnc";
import type { RawChannel } from "@novnc/novnc";
import { DESKTOP_CONTROL_LABELS, type DesktopControl } from "@gond/shared";
import { CircleCheck, CircleQuestionMark, CircleX, Hand, Keyboard, MonitorOff, RotateCw, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";

import { copyToClipboard, isPasteChord } from "@/components/hq/clipboard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function IconButton({
  label,
  onClick,
  container,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  container: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-lg" onClick={onClick} aria-label={label} className={cn("pointer-coarse:size-11", className)} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" container={container}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export type DesktopStatus = "starting" | "connecting" | "live" | "ended" | "error";
type Status = DesktopStatus;

export type DesktopReport = { status: DesktopStatus; message: string | null; notice: string | null; zoom: number };

export const INITIAL_REPORT: DesktopReport = { status: "starting", message: null, notice: null, zoom: 1 };

export type DesktopQuality = "thumb" | "full";

export type DesktopViewHandle = {
  reconnect: () => void;
  openKeyboard: () => void;
  closeKeyboard: () => void;
  zoomTo: (zoom: number) => void;
  typeText: (text: string) => void;
  copyToPhone: () => void;
  pasteFromPhone: () => Promise<boolean>;
  recenterPointer: () => void;
};

export const MAX_ZOOM = 5;
const TRACKPAD_TAP_MS = 250;
const TRACKPAD_SPEED = 1.5;
const POINTER_MARGIN = 32;
// A pinch that ends this close to the whole screen snaps back to it.
const ZOOM_SNAP = 1.08;

export function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
}

/** The view's size for a remote screen fitted into a stage, then zoomed. */
export function fittedSize(remote: { width: number; height: number }, stage: { width: number; height: number }, zoom: number) {
  const fit = Math.min(stage.width / remote.width, stage.height / remote.height);
  if (!Number.isFinite(fit) || fit <= 0) return { width: stage.width, height: stage.height };
  return { width: Math.floor(remote.width * fit * zoom), height: Math.floor(remote.height * fit * zoom) };
}

type GestureDetail = { type: string; clientX: number; clientY: number; magnitudeX?: number; magnitudeY?: number };

const DEFAULT_SIZE = { width: 1280, height: 800 };
const QUALITY: Record<DesktopQuality, { quality: number; compression: number }> = { thumb: { quality: 3, compression: 6 }, full: { quality: 6, compression: 2 } };

const KEYBOARD_FILLER = "\u00a0\u00a0\u00a0\u00a0";
const KEYSYM_BACKSPACE = 0xff08;
const KEYSYM_RETURN = 0xff0d;
const KEYSYM_TAB = 0xff09;

export function keysymOf(character: string): number {
  if (character === "\n" || character === "\r") return KEYSYM_RETURN;
  if (character === "\t") return KEYSYM_TAB;
  const code = character.codePointAt(0) ?? 0;

  return code <= 0xff ? code : 0x01000000 + code;
}

const PASTE_KEYSYMS: Record<string, number> = { KeyV: 0x76, Insert: 0xff63 };

const PASTE_EVENT_WAIT_MS = 250;

const NOTICE_MS = 2_500;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class SseChannel implements RawChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private source: EventSource | null = null;
  private queue: Uint8Array[] = [];
  private sending = false;

  constructor(
    private readonly base: string,
    private readonly id: string,
  ) {}

  start() {
    const source = new EventSource(`${this.base}/connections/${this.id}/stream`);
    this.source = source;
    source.onopen = () => {
      if (this.readyState !== "connecting") return;
      this.readyState = "open";
      this.onopen?.({});
    };
    source.onmessage = (event) => {
      const bytes = fromBase64(event.data as string);
      this.onmessage?.({ data: bytes.buffer as ArrayBuffer });
    };

    source.onerror = () => this.end(false);
  }

  send(data: Uint8Array) {
    if (this.readyState !== "open") return;

    this.queue.push(data.slice());
    void this.flush();
  }

  private async flush() {
    if (this.sending || this.queue.length === 0 || this.readyState !== "open") return;
    this.sending = true;
    const batch = this.queue.splice(0);
    const size = batch.reduce((total, part) => total + part.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const part of batch) {
      merged.set(part, offset);
      offset += part.length;
    }
    try {
      const res = await fetch(`${this.base}/connections/${this.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: toBase64(merged) }),
      });
      if (!res.ok) throw new Error(`input rejected (${res.status})`);
    } catch (error) {
      this.sending = false;
      this.onerror?.(error);
      this.end(false);
      return;
    }
    this.sending = false;
    void this.flush();
  }

  close() {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    void fetch(`${this.base}/connections/${this.id}`, { method: "DELETE" }).catch(() => undefined);
    this.end(true);
  }

  private end(clean: boolean) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.source?.close();
    this.source = null;
    this.queue = [];

    setTimeout(() => this.onclose?.({ clean }), 0);
  }
}

/** Where a bot's screen is reached through the API. */
export const screenUrl = (botId: string) => `/api/box/desktop/${encodeURIComponent(botId)}`;

export function DesktopView({
  botId,
  viewOnly,
  trackpad = false,
  quality,
  onStatus,
  onKeyboard,
  className,
  ref,
}: {
  botId: string;
  viewOnly: boolean;
  trackpad?: boolean;
  quality: DesktopQuality;
  onStatus?: (report: DesktopReport) => void;
  onKeyboard?: (open: boolean) => void;
  className?: string;
  ref?: Ref<DesktopViewHandle>;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const noticeTimer = useRef<number | undefined>(undefined);

  const lastSent = useRef<string | null>(null);

  const pendingCopy = useRef<string | null>(null);
  const remoteCopy = useRef<string | null>(null);

  // The view is laid out by hand, not by React: a pinch changes it every frame.
  const remote = useRef(DEFAULT_SIZE);
  const zoom = useRef(1);
  // Where trackpad mode's pointer is, in the remote screen's pixels.
  const pointer = useRef({ x: DEFAULT_SIZE.width / 2, y: DEFAULT_SIZE.height / 2 });

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  }, [onStatus]);
  const keyboardReport = useRef(onKeyboard);
  useEffect(() => {
    keyboardReport.current = onKeyboard;
  }, [onKeyboard]);
  const settings = useRef({ viewOnly, trackpad, quality });
  useEffect(() => {
    settings.current = { viewOnly, trackpad, quality };
  }, [viewOnly, trackpad, quality]);
  useEffect(() => {
    report.current?.({ status, message, notice, zoom: zoomLevel });
  }, [status, message, notice, zoomLevel]);

  const layout = useCallback(() => {
    const box = stage.current;
    const inner = sizer.current;
    if (!box || !inner) return;
    const room = { width: box.clientWidth, height: box.clientHeight };
    const size = fittedSize(remote.current, room, zoom.current);
    inner.style.width = `${size.width}px`;
    inner.style.height = `${size.height}px`;
  }, []);

  // Zooms so the point of the screen under `at` stays under it.
  const zoomAround = useCallback(
    (next: number, at: { x: number; y: number; u: number; v: number }) => {
      const box = stage.current;
      const inner = sizer.current;
      if (!box || !inner) return;
      zoom.current = clampZoom(next);
      layout();
      const room = box.getBoundingClientRect();
      box.scrollLeft = at.u * inner.offsetWidth - (at.x - room.left);
      box.scrollTop = at.v * inner.offsetHeight - (at.y - room.top);
    },
    [layout],
  );

  const anchorAt = useCallback((x: number, y: number) => {
    const rect = sizer.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x, y, u: 0.5, v: 0.5 };
    return { x, y, u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height };
  }, []);

  const zoomTo = useCallback(
    (next: number) => {
      const box = stage.current;
      if (!box) return;
      const room = box.getBoundingClientRect();
      zoomAround(next, anchorAt(room.left + room.width / 2, room.top + room.height / 2));
      setZoomLevel(zoom.current);
    },
    [anchorAt, zoomAround],
  );

  const pointerOnPage = useCallback(() => {
    const target = host.current?.querySelector("canvas");
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { target, x: rect.left + (pointer.current.x * rect.width) / remote.current.width, y: rect.top + (pointer.current.y * rect.height) / remote.current.height };
  }, []);

  const movePointer = useCallback(() => {
    const spot = pointerOnPage();
    if (!spot) return;
    spot.target.dispatchEvent(new MouseEvent("mousemove", { clientX: spot.x, clientY: spot.y, bubbles: true }));
  }, [pointerOnPage]);

  // Zoomed in, the view follows the pointer so it never leaves the screen.
  const followPointer = useCallback(() => {
    const box = stage.current;
    const spot = pointerOnPage();
    if (!box || !spot) return;
    const room = box.getBoundingClientRect();
    if (spot.x < room.left + POINTER_MARGIN) box.scrollLeft -= room.left + POINTER_MARGIN - spot.x;
    else if (spot.x > room.right - POINTER_MARGIN) box.scrollLeft += spot.x - (room.right - POINTER_MARGIN);
    if (spot.y < room.top + POINTER_MARGIN) box.scrollTop -= room.top + POINTER_MARGIN - spot.y;
    else if (spot.y > room.bottom - POINTER_MARGIN) box.scrollTop += spot.y - (room.bottom - POINTER_MARGIN);
  }, [pointerOnPage]);

  const recenterPointer = useCallback(() => {
    const box = stage.current;
    const target = host.current?.querySelector("canvas");
    if (!box || !target) return;
    const room = box.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const middle = { x: Math.max(room.left, rect.left) + Math.min(room.width, rect.width) / 2, y: Math.max(room.top, rect.top) + Math.min(room.height, rect.height) / 2 };
    pointer.current = { x: ((middle.x - rect.left) / rect.width) * remote.current.width, y: ((middle.y - rect.top) / rect.height) * remote.current.height };
    movePointer();
  }, [movePointer]);

  useEffect(() => {
    if (trackpad && status === "live") recenterPointer();
  }, [trackpad, status, recenterPointer]);

  // A phone drops the connection when the app goes to the background; the desktop itself runs on.
  useEffect(() => {
    if (status !== "ended") return;
    const back = () => {
      if (document.visibilityState === "visible") setAttempt((current) => current + 1);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [status]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setVisible(node.clientWidth > 0 && node.clientHeight > 0);
      layout();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [layout]);

  const onRemoteClipboard = useCallback(
    (text: string) => {
      if (!text) return;
      remoteCopy.current = text;
      void copyToClipboard(text).then((done) => {
        pendingCopy.current = done ? null : text;
        showNotice(done ? "Copied from the desktop" : "Copied in the desktop; click in it once to take it");
      });
    },
    [showNotice],
  );

  useEffect(() => {
    const node = host.current;
    if (!node || !visible) return;
    let disposed = false;
    let channel: SseChannel | null = null;
    let client: RFB | null = null;
    let canvasWatch: MutationObserver | null = null;

    let finished = false;
    setStatus("starting");
    setMessage(null);

    void (async () => {
      const { viewOnly, quality } = settings.current;
      // Nobody resizes the session: every view sees the bots' own screen, fitted inside it.
      const res = await fetch(`${screenUrl(botId)}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_SIZE),
      });
      const data = (await res.json().catch(() => ({}))) as {
        connection?: { id: string };
        error?: string;
      };
      if (disposed) return;
      if (!res.ok || !data.connection) {
        setStatus("error");
        setMessage(data.error ?? "Couldn't open the screen.");
        return;
      }
      setStatus("connecting");

      const { default: RFBClient } = await import("@novnc/novnc");
      if (disposed) return;
      channel = new SseChannel(screenUrl(botId), data.connection.id);
      client = new RFBClient(node, channel, { shared: true });
      client.scaleViewport = true;
      client.resizeSession = false;
      client.viewOnly = viewOnly;
      client.showDotCursor = true;
      client.background = "transparent";
      client.qualityLevel = QUALITY[quality].quality;
      client.compressionLevel = QUALITY[quality].compression;
      // noVNC sizes its canvas to the remote screen; that is the shape the view fits.
      const canvas = node.querySelector("canvas");
      if (canvas) {
        canvasWatch = new MutationObserver(() => {
          if (canvas.width > 0 && canvas.height > 0) remote.current = { width: canvas.width, height: canvas.height };
          layout();
        });
        canvasWatch.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
      }
      client.addEventListener("connect", () => {
        setStatus("live");
        if (!client?.viewOnly && !isCoarsePointer()) client?.focus();
      });
      client.addEventListener("disconnect", (event) => {
        finished = true;
        if (disposed) return;
        setStatus((current) => (current === "error" ? current : "ended"));
        if (!event.detail.clean) setMessage("The desktop connection dropped.");
      });
      client.addEventListener("securityfailure", (event) => {
        setStatus("error");
        setMessage(event.detail.reason ?? "The desktop refused the connection.");
      });
      client.addEventListener("clipboard", (event) => onRemoteClipboard(event.detail.text));
      rfb.current = client;
      channel.start();
    })();

    return () => {
      disposed = true;
      rfb.current = null;
      canvasWatch?.disconnect();

      if (client && !finished) client.disconnect();
      else channel?.close();
    };
  }, [attempt, visible, onRemoteClipboard, layout, botId]);

  useEffect(() => {
    const client = rfb.current;
    if (!client) return;
    client.viewOnly = viewOnly;
    if (!viewOnly && status === "live" && !isCoarsePointer()) client.focus();
  }, [viewOnly, status]);

  // noVNC reads the touches (tap, hold, drag, two-finger scroll) and says
  // what it saw as gesture events, which don't bubble but do pass through
  // here on the way down to its canvas. Its pinch would only send Ctrl+scroll
  // to the desktop, so a pinch zooms this view; zoomed in, two fingers move
  // around it instead of scrolling. In trackpad mode a finger moves the
  // pointer, and the taps, drags and scrolls are sent on to noVNC again at
  // the pointer, marked so they pass.
  useEffect(() => {
    const box = stage.current;
    const canvas = () => host.current?.querySelector("canvas") ?? null;
    if (!box) return;
    let pinch: { from: number; zoom: number; at: { x: number; y: number; u: number; v: number } } | null = null;
    let pan: { x: number; y: number } | null = null;
    let steer: { x: number; y: number; dragging: boolean } | null = null;
    let tap: { timer: number; type: string } | null = null;
    let scroll = false;

    const replay = (type: string, gesture: string, extra: Partial<GestureDetail> = {}) => {
      const spot = pointerOnPage();
      if (!spot) return;
      spot.target.dispatchEvent(new CustomEvent(type, { detail: { type: gesture, clientX: spot.x, clientY: spot.y, ...extra, gond: true } }));
    };
    const tapAtPointer = (gesture: string) => {
      replay("gesturestart", gesture);
      replay("gestureend", gesture);
    };
    const flushTap = () => {
      if (!tap) return;
      window.clearTimeout(tap.timer);
      tapAtPointer(tap.type);
      tap = null;
    };

    const onGesture = (event: Event) => {
      const detail = (event as CustomEvent<GestureDetail & { gond?: boolean }>).detail;
      if (detail.gond) return;
      const phase = event.type;

      if (detail.type === "pinch") {
        event.stopPropagation();
        const distance = Math.hypot(detail.magnitudeX ?? 0, detail.magnitudeY ?? 0);
        if (phase === "gesturestart") {
          pinch = { from: distance || 1, zoom: zoom.current, at: anchorAt(detail.clientX, detail.clientY) };
        } else if (pinch && phase === "gesturemove") {
          zoomAround(pinch.zoom * (distance / pinch.from), pinch.at);
        } else if (phase === "gestureend") {
          pinch = null;
          if (zoom.current < ZOOM_SNAP) zoomTo(1);
          else setZoomLevel(zoom.current);
        }
        return;
      }

      const trackpad = settings.current.trackpad && !settings.current.viewOnly;
      // A twodrag's position stays where it began; its magnitude is how far it went.
      const x = detail.clientX + (detail.type === "twodrag" ? (detail.magnitudeX ?? 0) : 0);
      const y = detail.clientY + (detail.type === "twodrag" ? (detail.magnitudeY ?? 0) : 0);
      const pans = (detail.type === "twodrag" || (detail.type === "drag" && settings.current.viewOnly)) && zoom.current > 1;
      if (phase === "gesturestart" && pans) pan = { x, y };
      if (pan) {
        event.stopPropagation();
        box.scrollLeft -= x - pan.x;
        box.scrollTop -= y - pan.y;
        pan = phase === "gestureend" ? null : { x, y };
        return;
      }
      if (!trackpad) return;
      event.stopPropagation();

      switch (detail.type) {
        case "onetap":
          if (phase !== "gestureend") return;
          // Held back a moment: a tap and then a drag is a drag with the button down.
          flushTap();
          tap = { type: "onetap", timer: window.setTimeout(() => flushTap(), TRACKPAD_TAP_MS) };
          return;
        case "twotap":
        case "threetap":
          if (phase === "gestureend") {
            flushTap();
            tapAtPointer(detail.type);
          }
          return;
        case "longpress":
          if (phase === "gesturestart") {
            flushTap();
            tapAtPointer("twotap");
          }
          return;
        case "twodrag":
          if (phase === "gesturestart") {
            scroll = true;
            replay("gesturestart", "twodrag", { magnitudeX: 0, magnitudeY: 0 });
          } else if (scroll) {
            replay(phase, "twodrag", { magnitudeX: detail.magnitudeX ?? 0, magnitudeY: detail.magnitudeY ?? 0 });
            if (phase === "gestureend") scroll = false;
          }
          return;
        case "drag": {
          if (phase === "gesturestart") {
            const dragging = tap !== null;
            if (tap) window.clearTimeout(tap.timer);
            tap = null;
            steer = { x, y, dragging };
            if (dragging) replay("gesturestart", "drag");
            return;
          }
          if (!steer) return;
          const target = canvas();
          const rect = target?.getBoundingClientRect();
          if (target && rect && rect.width > 0) {
            const scale = (TRACKPAD_SPEED * remote.current.width) / rect.width;
            pointer.current = {
              x: Math.min(remote.current.width - 1, Math.max(0, pointer.current.x + (x - steer.x) * scale)),
              y: Math.min(remote.current.height - 1, Math.max(0, pointer.current.y + (y - steer.y) * scale)),
            };
            followPointer();
            if (steer.dragging) replay(phase === "gestureend" ? "gestureend" : "gesturemove", "drag");
            else movePointer();
          }
          steer = phase === "gestureend" ? null : { ...steer, x, y };
          return;
        }
      }
    };

    const types = ["gesturestart", "gesturemove", "gestureend"];
    for (const type of types) box.addEventListener(type, onGesture, true);
    return () => {
      if (tap) window.clearTimeout(tap.timer);
      for (const type of types) box.removeEventListener(type, onGesture, true);
    };
  }, [anchorAt, zoomAround, zoomTo, followPointer, movePointer, pointerOnPage]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const swallowed = new Set<string>();
    let pending: { code: string; timer: number } | null = null;

    const replay = (code: string) => {
      const client = rfb.current;
      const keysym = PASTE_KEYSYMS[code];
      if (client && keysym) client.sendKey(keysym, code);
    };
    const settle = () => {
      if (!pending) return;
      window.clearTimeout(pending.timer);
      const { code } = pending;
      pending = null;
      return code;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!rfb.current || rfb.current.viewOnly || !isPasteChord(event) || !(event.code in PASTE_KEYSYMS)) return;
      event.stopPropagation();
      swallowed.add(event.code);
      const code = event.code;
      if (pending) window.clearTimeout(pending.timer);
      pending = {
        code,
        timer: window.setTimeout(() => {
          pending = null;
          replay(code);
        }, PASTE_EVENT_WAIT_MS),
      };
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!swallowed.delete(event.code)) return;
      event.stopPropagation();
    };
    const onPaste = (event: ClipboardEvent) => {
      const client = rfb.current;
      if (!client || client.viewOnly) return;
      const code = settle();
      const active = document.activeElement;

      if (!code && active && active !== document.body && !node.contains(active)) return;
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text && text !== lastSent.current) {
        lastSent.current = text;
        client.clipboardPasteFrom(text);
      }
      if (code) replay(code);
    };

    node.addEventListener("keydown", onKeyDown, true);
    node.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("paste", onPaste);
    return () => {
      settle();
      node.removeEventListener("keydown", onKeyDown, true);
      node.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const retry = () => {
      const text = pendingCopy.current;
      if (!text) return;
      pendingCopy.current = null;
      void copyToClipboard(text).then((done) => {
        if (done) showNotice("Copied from the desktop");
        else pendingCopy.current = text;
      });
    };
    node.addEventListener("pointerdown", retry, true);
    node.addEventListener("keydown", retry, true);
    return () => {
      node.removeEventListener("pointerdown", retry, true);
      node.removeEventListener("keydown", retry, true);
    };
  }, [showNotice]);

  const onTyped = useCallback(() => {
    const field = keyboard.current;
    const client = rfb.current;
    if (!field || !client) return;
    const typed = field.value;
    if (typed.length > KEYBOARD_FILLER.length) {
      for (const character of typed.slice(KEYBOARD_FILLER.length)) client.sendKey(keysymOf(character), null);
    } else {
      for (let i = typed.length; i < KEYBOARD_FILLER.length; i += 1) client.sendKey(KEYSYM_BACKSPACE, null);
    }
    field.value = KEYBOARD_FILLER;
    field.setSelectionRange(KEYBOARD_FILLER.length, KEYBOARD_FILLER.length);
  }, []);

  const openKeyboard = useCallback(() => {
    const field = keyboard.current;
    if (!field) return;
    field.value = KEYBOARD_FILLER;
    field.focus({ preventScroll: true });
    field.setSelectionRange(KEYBOARD_FILLER.length, KEYBOARD_FILLER.length);
  }, []);

  const typeText = useCallback((text: string) => {
    const client = rfb.current;
    if (!client || client.viewOnly || !text) return;
    lastSent.current = text;
    client.clipboardPasteFrom(text);
    // Typed rather than Ctrl+V, which a terminal doesn't take as paste.
    for (const character of text) client.sendKey(keysymOf(character), null);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reconnect: () => setAttempt((current) => current + 1),
      openKeyboard,
      closeKeyboard: () => keyboard.current?.blur(),
      zoomTo,
      typeText,
      copyToPhone: () => {
        const text = remoteCopy.current;
        if (!text) {
          showNotice("Copy something on the computer first");
          return;
        }
        void copyToClipboard(text).then((done) => {
          if (done) pendingCopy.current = null;
          showNotice(done ? "Copied to your phone" : "Couldn't copy to your phone");
        });
      },
      recenterPointer,
      pasteFromPhone: async () => {
        const text = await navigator.clipboard?.readText?.().catch(() => null);
        if (!text) return false;
        typeText(text);
        showNotice("Pasted from your phone");
        return true;
      },
    }),
    [openKeyboard, zoomTo, typeText, showNotice, recenterPointer],
  );

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div ref={stage} data-no-swipe-back="" className="h-full touch-none overflow-hidden overscroll-contain">
        <div className="flex min-h-full w-max min-w-full">
          <div ref={sizer} className="m-auto shrink-0">
            <div ref={host} className="size-full [&>div]:h-full" />
          </div>
        </div>
      </div>

      {viewOnly ? null : (
        <textarea
          ref={keyboard}
          onInput={onTyped}
          onFocus={() => keyboardReport.current?.(true)}
          onBlur={() => keyboardReport.current?.(false)}
          defaultValue={KEYBOARD_FILLER}
          aria-label="Type on the desktop"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none absolute bottom-0 left-0 size-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0 outline-none"
        />
      )}
    </div>
  );
}

function isCoarsePointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

function StatusIcon({ status }: { status: DesktopStatus }) {
  if (status === "live") return <CircleCheck role="img" aria-label="Connected" className="size-4 shrink-0 text-tone-ok" />;
  if (status === "starting" || status === "connecting") return <Spinner aria-label={status === "starting" ? "Starting the desktop" : "Connecting"} className="size-4 shrink-0 text-muted-foreground" />;
  return <CircleX role="img" aria-label={status === "error" ? "Couldn't connect" : "Disconnected"} className="size-4 shrink-0 text-muted-foreground" />;
}

export function ControlChip({ control, className }: { control: DesktopControl; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-primary-edge bg-primary px-2 py-0.5 text-[11px]", control === "person" ? "text-tone-ok" : control === "bots" ? "text-tone-warn" : "text-muted-foreground", className)}>
      {control === "bots" ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}
      {DESKTOP_CONTROL_LABELS[control]}
    </span>
  );
}

/** The pills over a wide screen's window, the way a conversation's header floats over its messages. */
export function DesktopToolbar({
  title,
  icon,
  driver,
  report,
  control,
  onControlChange,
  view,
  onHelp,
  onStop,
  onClose,
  closeLabel,
  className,
}: {
  title: string;
  icon?: ReactNode;
  driver?: string;
  report: DesktopReport;
  control?: DesktopControl;
  onControlChange?: (holder: "person" | "free") => void;
  view: RefObject<DesktopViewHandle | null>;
  onHelp?: () => void;
  onStop?: () => void;
  onClose: () => void;
  closeLabel: string;
  className?: string;
}) {
  const { status, message, notice, zoom } = report;
  const bar = useRef<HTMLSpanElement>(null);
  const live = status === "live";
  const zoomed = zoom > 1;
  const said = notice ?? message ?? (control === "bots" && driver ? `${driver} is using it` : control ? DESKTOP_CONTROL_LABELS[control] : null);
  return (
    <div className={cn("relative flex items-center gap-2", className)}>
      {/* The tooltips' layer: out of the flex row, so one opening never shifts the pills. */}
      <span ref={bar} className="absolute top-0 left-0" />
      <div className={cn("flex h-9 min-w-0 shrink items-center gap-2 rounded-full border border-primary-edge bg-primary pr-3.5 text-[13px] font-medium text-primary-foreground", icon ? "pl-1" : "pl-3.5")}>
        {icon ? <span className="flex size-7 shrink-0 items-center justify-center [&>*]:scale-[0.875]">{icon}</span> : null}
        <span className="truncate">{title}</span>
        <StatusIcon status={status} />
      </div>
      {said ? (
        <div className="flex h-9 min-w-0 shrink items-center gap-2 rounded-full border border-primary-edge bg-primary px-3.5 text-[12px] text-muted-foreground">
          {control === "bots" && !notice && !message ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-tone-warn" aria-hidden="true" /> : null}
          <span className="truncate">{said}</span>
        </div>
      ) : null}
      <span className="flex-1" />
      {status === "ended" || status === "error" ? (
        <Button size="lg" onClick={() => view.current?.reconnect()} className="pointer-coarse:h-11">
          <RotateCw data-icon="inline-start" aria-hidden="true" />
          Reconnect
        </Button>
      ) : null}
      {control && onControlChange && live ? (
        <Button size="lg" onClick={() => onControlChange(control === "person" ? "free" : "person")} className="pointer-coarse:h-11">
          {control === "person" ? <Undo2 data-icon="inline-start" aria-hidden="true" /> : <Hand data-icon="inline-start" aria-hidden="true" />}
          {control === "person" ? "Give control back" : "Take control"}
        </Button>
      ) : null}
      {live ? (
        <IconButton container={bar} label={zoomed ? "Fit the screen" : "Zoom in"} onClick={() => view.current?.zoomTo(zoomed ? 1 : 2)} className="hidden pointer-coarse:flex">
          {zoomed ? <ZoomOut /> : <ZoomIn />}
        </IconButton>
      ) : null}
      {live && control !== "bots" ? (
        <IconButton container={bar} label="Keyboard" onClick={() => view.current?.openKeyboard()} className="hidden pointer-coarse:flex">
          <Keyboard />
        </IconButton>
      ) : null}
      {onHelp ? (
        <IconButton container={bar} label="How to use the screen" onClick={onHelp} className="hidden pointer-coarse:flex">
          <CircleQuestionMark />
        </IconButton>
      ) : null}
      {onStop ? (
        <IconButton container={bar} label="Stop the desktop" onClick={onStop}>
          <MonitorOff />
        </IconButton>
      ) : null}
      <IconButton container={bar} label={closeLabel} onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

/** Full screen on a phone, the page behind it; a window over a dimmed page on a wide screen. */
export function DesktopFrame({ frame, onBackdrop, backdropLabel, bar, children }: { frame: RefObject<HTMLDivElement | null>; onBackdrop: () => void; backdropLabel: string; bar?: ReactNode; children: ReactNode }) {
  return (
    <div data-no-swipe-back="" className="fixed inset-0 z-[70] flex items-center justify-center bg-background wide:bg-transparent wide:p-6">
      <button type="button" aria-label={backdropLabel} className="absolute inset-0 hidden bg-black/60 wide:block" onClick={onBackdrop} />
      <div className="pointer-events-none relative flex h-full w-full flex-col wide:h-auto wide:w-[min(70vw,1040px)] wide:gap-2.5 [&>*]:pointer-events-auto">
        {bar}
        <div ref={frame} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background wide:aspect-[16/10] wide:max-h-[calc(100dvh-7rem)] wide:flex-none wide:rounded-3xl wide:border wide:border-primary-edge wide:bg-card wide:shadow-subtle-3">
          {children}
        </div>
      </div>
    </div>
  );
}
