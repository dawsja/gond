"use client";

import { isPaused, type Approval, type Message } from "@gond/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { api } from "@/lib/api";
import { approvalBatches, APPROVALS_PER_REQUEST, hasEarlier, markGone, mergeMessages, newestOf, putApprovals } from "@/lib/history";
import { singleFlight } from "@/lib/single-flight";

/** One page: the newest `limit`, the `limit` before `before`, or what came `from` a time on, lines stamped then included. */
export type PageQuery = { before?: string; from?: string; limit: number };

const CATCH_UP = 200;
const CATCH_UP_ROUNDS = 5;

type History = { messages: Message[]; earlier: boolean | null; failed: boolean };

function withMessages(history: History, messages: Message[]): History {
  return messages === history.messages ? history : { ...history, messages };
}

/**
 * A list of messages loaded a page at a time, newest first, and the approvals its cards show. The
 * first page loads on mount; `catchUp` adds what came since, `loadEarlier` the page before, `reload`
 * starts over. Every page is merged by id in time order and has its approvals read in one request.
 * Give a list of other messages its own mount (a `key`).
 */
export function useMessageHistory(fetchPage: (query: PageQuery) => Promise<Message[]>, { page }: { page: number }) {
  const [history, setHistory] = useState<History>({ messages: [], earlier: null, failed: false });
  // null: the server answered without it, so the card it belongs to is gone.
  const [approvals, setApprovals] = useState<ReadonlyMap<string, Approval | null>>(() => new Map());
  const read = useStableCallback(fetchPage);
  const shown = useRef<Message[]>([]);
  const newest = useRef<string | null>(null);
  // A reload makes every page still on its way stale.
  const round = useRef(0);
  const asked = useRef(new Set<string>());
  const earlierRun = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    shown.current = history.messages;
  }, [history.messages]);

  const askApprovals = useStableCallback(async (ids: string[]) => {
    const data = await api<{ approvals: Approval[] }>(`/api/approvals?ids=${ids.map(encodeURIComponent).join(",")}`);
    const found = new Set(data.approvals.map((a) => a.id));
    setApprovals((current) => markGone(putApprovals(current, data.approvals), ids.filter((id) => !found.has(id))));
  });

  const hydrate = useStableCallback((messages: readonly Message[]) => {
    for (const ids of approvalBatches(messages, asked.current)) {
      for (const id of ids) asked.current.add(id);
      void askApprovals(ids).catch(() => {
        for (const id of ids) asked.current.delete(id);
      });
    }
  });

  const refreshApprovals = useStableCallback(async () => {
    hydrate(shown.current);
    const open = [...approvals.values()].filter((a): a is Approval => a !== null && (a.status === "pending" || isPaused(a))).map((a) => a.id);
    for (let at = 0; at < open.length; at += APPROVALS_PER_REQUEST) await askApprovals(open.slice(at, at + APPROVALS_PER_REQUEST)).catch(() => undefined);
  });

  const putApproval = useStableCallback((approval: Approval) => setApprovals((current) => putApprovals(current, [approval])));

  const reload = useStableCallback(async () => {
    const mine = ++round.current;
    const messages = await read({ limit: page }).catch(() => null);
    if (mine !== round.current) return;
    if (!messages) return setHistory((current) => ({ ...current, failed: true }));
    newest.current = newestOf(null, messages);
    setHistory({ messages, earlier: hasEarlier(messages, page), failed: false });
    hydrate(messages);
  });

  const catchUpNow = useStableCallback(async () => {
    // Cards whose approvals failed to load get another try; `asked` skips the rest.
    hydrate(shown.current);
    const mine = round.current;
    for (let rounds = 0; rounds < CATCH_UP_ROUNDS; rounds += 1) {
      const from = newest.current;
      if (!from) return reload();
      const messages = await read({ from, limit: CATCH_UP }).catch(() => null);
      if (!messages || mine !== round.current) return;
      newest.current = newestOf(newest.current, messages);
      if (messages.length) {
        setHistory((current) => withMessages(current, mergeMessages(current.messages, messages)));
        hydrate(messages);
      }
      if (messages.length < CATCH_UP) return;
    }
  });
  const catchUp = useMemo(() => singleFlight(catchUpNow), [catchUpNow]);

  const loadEarlier = useStableCallback((limit: number = page): Promise<boolean> => {
    if (earlierRun.current) return earlierRun.current;
    const run = (async () => {
      const first = shown.current[0]?.createdAt;
      if (!first) return false;
      const mine = round.current;
      const messages = await read({ before: first, limit }).catch(() => null);
      if (mine !== round.current) return false;
      if (!messages) {
        toast.add({ type: "error", title: "Couldn't load earlier messages." });
        return false;
      }
      setHistory((current) => ({ ...current, messages: mergeMessages(current.messages, messages), earlier: hasEarlier(messages, limit) }));
      hydrate(messages);
      return messages.length > 0;
    })().finally(() => {
      earlierRun.current = null;
    });
    earlierRun.current = run;
    return run;
  });

  /** Lines this page made itself (a send's answer): shown at once, and they never move the catch-up's place. */
  const add = useStableCallback((messages: Message[]) => setHistory((current) => withMessages(current, mergeMessages(current.messages, messages))));
  const update = useStableCallback((change: (messages: Message[]) => Message[]) => setHistory((current) => withMessages(current, change(current.messages))));

  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);

  return { ...history, approvals, reload, catchUp, loadEarlier, add, update, putApproval, refreshApprovals };
}
