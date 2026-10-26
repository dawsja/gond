"use client";

import type { Message } from "@gond/shared";
import { del, patch, post } from "@/lib/api";

const path = (threadId: string, messageId: string) => `/api/threads/${threadId}/messages/${messageId}`;

/** Puts the person's message back to wait after a turn on it failed; the failure line goes and the conversation reloads. */
export const retryTurn = (threadId: string, messageId: string) => post<{ ok: true }>(`${path(threadId, messageId)}/retry`);

/** Takes back a line no bot has read yet. */
export const unsend = (threadId: string, messageId: string) => del(path(threadId, messageId));

/** Changes a line no bot has read yet, in place. */
export const editUnread = (threadId: string, messageId: string, body: string) => patch<{ message: Message }>(path(threadId, messageId), { body });
