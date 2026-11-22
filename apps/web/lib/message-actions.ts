"use client";

import type { Message } from "@gond/shared";
import { del, patch, post } from "@/lib/api";

const path = (threadId: string, messageId: string) => `/api/threads/${threadId}/messages/${messageId}`;

export const retryTurn = (threadId: string, messageId: string) => post<{ ok: true }>(`${path(threadId, messageId)}/retry`);

export const unsend = (threadId: string, messageId: string) => del(path(threadId, messageId));

export const editUnread = (threadId: string, messageId: string, body: string) => patch<{ message: Message }>(path(threadId, messageId), { body });
