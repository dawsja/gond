"use client";

import { useEffect, useState } from "react";
import type { ThreadAction } from "@/components/thread-actions";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { avatarPng, hexOf, useNativeChrome, type ChromeEvent, type ChromeState } from "@/lib/native-ui";

// What on the page covers the conversation, so the app's header and composer step aside for it. The
// composer's own / list is part of the composer.
const COVERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

type Props = Omit<ChromeState, "faces" | "tint" | "menu" | "covered" | "composer" | "mentions"> & {
  avatarKey: string;
  mentions: { id: string; handle: string }[];
  menu: ThreadAction[][];
  composer: ChromeState["composer"];
  onEvent: (event: ChromeEvent) => void;
};

/**
 * A conversation's header and composer in the iPhone app: the page keeps its own in place, unseen,
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

  const handle = useStableCallback(onEvent);

  const state: ChromeState = {
    ...header,
    faces,
    tint,
    covered,
    menu: menu.map((group) => group.map(({ id, label, symbol, destructive }) => ({ id, label, symbol, destructive }))),
    mentions: mentions.map((m) => ({ ...m, face: mentionFaces[m.id] ?? null })),
    composer,
  };
  useNativeChrome(state, handle);
  return null;
}

/** Each room member's face from the page's unseen copies, by bot id, as PNGs. */
function useMentionFaces(key: string): Record<string, string> {
  const [faces, setFaces] = useState<Record<string, string>>({});
  useEffect(() => {
    let stale = false;
    const frame = window.requestAnimationFrame(() => {
      const holders = [...document.querySelectorAll<HTMLElement>("[data-native-mention]")];
      void Promise.all(holders.map(async (holder) => [holder.dataset.nativeMention!, await avatarPng(holder)] as const)).then((pairs) => {
        if (!stale) setFaces(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]))));
      });
    });
    return () => {
      stale = true;
      window.cancelAnimationFrame(frame);
    };
  }, [key]);
  return faces;
}

/** The faces in the page's (unseen) header pill, front one first, as PNGs. */
function useFaces(key: string): string[] {
  const [faces, setFaces] = useState<string[]>([]);
  useEffect(() => {
    let stale = false;
    // The pill renders with the conversation; a frame later its faces are drawn.
    const frame = window.requestAnimationFrame(() => {
      const avatars = [...document.querySelectorAll("[data-native-avatar] [data-slot=bot-avatar]")].reverse().slice(0, 2);
      void Promise.all(avatars.map((avatar) => avatarPng(avatar))).then((pngs) => {
        if (!stale) setFaces(pngs.filter((png): png is string => Boolean(png)));
      });
    });
    return () => {
      stale = true;
      window.cancelAnimationFrame(frame);
    };
  }, [key]);
  return faces;
}

export function useCovered(): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const check = () => setCovered([...document.querySelectorAll(COVERS)].some((el) => !el.closest("[data-native-composer]") && !el.closest("[data-closed]")));
    void Promise.resolve().then(check);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-closed", "role"] });
    return () => observer.disconnect();
  }, []);
  return covered;
}

/** The person's own colour as the page paints Send, for the app's send button. */
function useTint(): string {
  const [tint, setTint] = useState("");
  useEffect(() => {
    const read = () => setTint(hexOf(getComputedStyle(document.documentElement).getPropertyValue("--tint-solid").trim()));
    void Promise.resolve().then(read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent", "class"] });
    return () => observer.disconnect();
  }, []);
  return tint;
}
