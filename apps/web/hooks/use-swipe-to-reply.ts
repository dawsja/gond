"use client";

import { useEffect, useRef, type RefObject } from "react";

// The screen's left edge is swipe-back's (`use-swipe-back.ts`).
const EDGE = 28;
export const REPLY_DISTANCE = 56;
const MAX = 80;

/** A bubble dragged right on a touch screen follows the finger, and past `REPLY_DISTANCE` it is a reply. */
export function useSwipeToReply(target: RefObject<HTMLElement | null>, enabled: boolean, onOffset: (px: number) => void, onReply: () => void) {
  const reply = useRef(onReply);
  const offset = useRef(onOffset);
  useEffect(() => {
    reply.current = onReply;
    offset.current = onOffset;
  });
  useEffect(() => {
    const node = target.current;
    if (!node || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let dx = 0;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      // A drag inside a code block or a wide table scrolls it sideways; it isn't a reply.
      const sideways = event.target instanceof Element && event.target.closest("pre, [data-scroll-x]");
      start = touch && event.touches.length === 1 && touch.clientX > EDGE && !sideways ? { x: touch.clientX, y: touch.clientY } : null;
      dragging = false;
      dx = 0;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const x = touch.clientX - start.x;
      const y = Math.abs(touch.clientY - start.y);
      if (!dragging) {
        if (y > 12) return void (start = null);
        if (x < 10 || x < y * 1.5) return;
        dragging = true;
      }
      dx = Math.max(0, Math.min(MAX, x * 0.7));
      offset.current(dx);
    };
    const onEnd = () => {
      if (dragging && dx >= REPLY_DISTANCE) {
        navigator.vibrate?.(8);
        reply.current();
      }
      if (dragging) offset.current(0);
      start = null;
      dragging = false;
    };
    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: true });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [target, enabled]);
}
