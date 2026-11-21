"use client";

import { useEffect, useState } from "react";
import type { ThreadAction } from "@/components/thread-actions";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { avatarPng, hexOf, picturesLoaded, useNativeChrome, type ChromeEvent, type ChromeState } from "@/lib/native-ui";

// What on the page covers the conversation, so the app's header and composer step aside for it. The
// composer's own / list is part of the composer.
const COVERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

type Props = Omit<ChromeState, "faces" | "tint" | "menu" | "covered" | "composer" | "mentions" | "column"> & {
  avatarKey: string;
  mentions: { id: string; handle: string }[];
  menu: ThreadAction[][];
  composer: ChromeState["composer"];
  onEvent: (event: ChromeEvent) => void;
};

/**
 * A conversation's header and composer in the iPhone and Mac apps: the page keeps its own in place, unseen,
 * and hands the app what they show; the app draws them in Liquid Glass and sends back what the person
 * did. The text the person types lives in the app's field while they type: the page's copy only goes
 * back to it when the page changed it itself (sent, a mention, a dictation), counted by `textRev`, which
 * the page raises for its own changes alone (`changeDraft`).
 */
export function ConversationChrome({ avatarKey, menu, composer, mentions, onEvent, ...header }: Props) {
  const faces = useFaces(avatarKey);
  const mentionFaces = useMentionFaces(mentions.map((m) => m.id).join(",") + avatarKey);
  const covered = useCovered();
  const tint = useTint();
  const column = useColumn();

  const handle = useStableCallback(onEvent);

  const state: ChromeState = {
    ...header,
    faces,
    tint,
    covered,
    column,
    menu: menu.map((group) => group.map(({ id, label, symbol, destructive }) => ({ id, label, symbol, destructive }))),
    mentions: mentions.map((m) => ({ ...m, face: mentionFaces[m.id] ?? null })),
    composer,
  };
  useNativeChrome(state, handle);
  return null;
}

// How many times, a quarter second apart, a face waits for a picture still loading before it is drawn without it.
const PICTURE_TRIES = 20;

/** Each room member's face from the page's unseen copies, by bot id, as PNGs. */
function useMentionFaces(key: string): Record<string, string> {
  const [faces, setFaces] = useState<Record<string, string>>({});
  useEffect(() => {
    let stale = false;
    let tries = 0;
    let timer = 0;
    const draw = () => {
      const holders = [...document.querySelectorAll<HTMLElement>("[data-native-mention]")];
      if (!holders.every(picturesLoaded) && (tries += 1) < PICTURE_TRIES) {
        timer = window.setTimeout(draw, 250);
        return;
      }
      void Promise.all(holders.map(async (holder) => [holder.dataset.nativeMention!, await avatarPng(holder)] as const)).then((pairs) => {
        if (!stale) setFaces(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]))));
      });
    };
    const frame = window.requestAnimationFrame(draw);
    return () => {
      stale = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [key]);
  return faces;
}

/** The faces in the page's (unseen) header pill, front one first, as PNGs. */
function useFaces(key: string): string[] {
  const [faces, setFaces] = useState<string[]>([]);
  useEffect(() => {
    let stale = false;
    let tries = 0;
    let timer = 0;
    // The pill renders with the conversation; a frame later its faces are drawn, once a bot's picture has loaded.
    const draw = () => {
      const avatars = [...document.querySelectorAll("[data-native-avatar] [data-slot=bot-avatar]")].reverse().slice(0, 2);
      if (!avatars.every(picturesLoaded) && (tries += 1) < PICTURE_TRIES) {
        timer = window.setTimeout(draw, 250);
        return;
      }
      void Promise.all(avatars.map((avatar) => avatarPng(avatar))).then((pngs) => {
        if (!stale) setFaces(pngs.filter((png): png is string => Boolean(png)));
      });
    };
    const frame = window.requestAnimationFrame(draw);
    return () => {
      stale = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [key]);
  return faces;
}

/** The conversation's own stretch of the web view (`data-native-column`), which the details panel narrows. */
function useColumn(): ChromeState["column"] {
  const [column, setColumn] = useState({ x: 0, width: 0 });
  useEffect(() => {
    const section = document.querySelector("[data-native-column]");
    if (!section) return;
    const read = () => {
      const box = section.getBoundingClientRect();
      const x = Math.round(box.left);
      const width = Math.round(box.width);
      setColumn((now) => (now.x === x && now.width === width ? now : { x, width }));
    };
    void Promise.resolve().then(read);
    const observer = new ResizeObserver(read);
    observer.observe(section);
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, []);
  return column;
}

/** What of the page's is open over everything, oldest first. */
export function pageCovers(): Element[] {
  return [...document.querySelectorAll(COVERS)].filter((el) => !el.closest("[data-native-composer]") && !el.closest("[data-closed]"));
}

/** Closes what is open on top, as Escape would: the app's scrim over its own sidebar and chrome was clicked. */
export function dismissTopmost() {
  const top = pageCovers().at(-1);
  if (!top) return;
  const target = document.activeElement && top.contains(document.activeElement) ? document.activeElement : top;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

export function useCovered(): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const check = () => setCovered(pageCovers().length > 0);
    void Promise.resolve().then(check);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-closed", "role"] });
    return () => observer.disconnect();
  }, []);
  return covered;
}

/** The person's own colour as the page paints Send, for the app's send button. */
function useTint(): string {
  return useTokenHex("--tint-solid");
}

/** A colour token as #rrggbb, read again when the theme or the accent changes. */
export function useTokenHex(token: string): string {
  const [hex, setHex] = useState("");
  useEffect(() => {
    const read = () => setHex(hexOf(getComputedStyle(document.documentElement).getPropertyValue(token).trim()));
    void Promise.resolve().then(read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent", "class"] });
    return () => observer.disconnect();
  }, [token]);
  return hex;
}
