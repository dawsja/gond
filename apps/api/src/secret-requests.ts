import type { Bot, LoginField, SecretRequest } from "@gond/shared";
import { cardExpired } from "./approvals.ts";
import { approvalTimeoutMs } from "./config.ts";
import { hasComposioKey } from "./data/composio-keys.ts";
import { createSecretRequest, hasSecret, resolveSecretRequest } from "./data/secrets.ts";
import { postMessage } from "./data/threads.ts";
import { sendPush } from "./push.ts";

type Pending = { resolve: (status: SecretRequest["status"]) => void; timer: ReturnType<typeof setTimeout> };
const holder = globalThis as typeof globalThis & { __gondPendingSecrets?: Map<string, Pending> };

function pending(): Map<string, Pending> {
  return (holder.__gondPendingSecrets ??= new Map());
}

export async function requestSecret(input: { bot: Bot; threadId: string; name: string; reason: string; target?: SecretRequest["target"]; site?: string; fields?: LoginField[]; replace?: boolean; total?: string | null; signal?: AbortSignal }): Promise<SecretRequest["status"] | "exists" | "missing"> {
  const target = input.target ?? "secret";
  const already = target === "login" || target === "card" ? false : target === "composio" ? hasComposioKey(input.bot.userId) : hasSecret(input.bot.userId, input.name);
  const replaces = target === "secret" && input.replace === true;
  if (replaces && !already) return "missing";
  if (already && !replaces) return "exists";
  const request = createSecretRequest({ botId: input.bot.id, threadId: input.threadId, name: input.name, reason: input.reason, target, site: input.site, fields: input.fields, replaces, total: input.total ?? null });
  const line = target === "login" ? `Sign in to ${input.site}: ${input.reason}` : target === "card" ? `Pay on ${input.site}${input.total ? `, ${input.total}` : ""}: ${input.reason}` : `${input.name}: ${input.reason}`;
  postMessage({ threadId: input.threadId, author: input.bot.id, kind: "secret", body: line, approvalId: request.id, answered: true });
  const title = target === "login" ? `${input.bot.name} needs you to sign in` : target === "card" ? `${input.bot.name} needs a card to pay` : `${input.bot.name} needs a secret`;
  if (input.bot.notify) void sendPush({ title, body: line.slice(0, 140), url: `/app/t/${input.threadId}`, tag: input.threadId, threadId: input.threadId }, input.bot.userId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending().delete(request.id);
      resolveSecretRequest(request.id, "expired");
      resolve("expired");
      cardExpired(input.bot, input.threadId, input.signal);
    }, approvalTimeoutMs());
    pending().set(request.id, { resolve, timer });
  });
}

export function answerSecretRequest(id: string, status: "given" | "declined", card: string | null = null): SecretRequest | null {
  const waiting = pending().get(id);
  const request = resolveSecretRequest(id, status, card);
  if (waiting) {
    clearTimeout(waiting.timer);
    pending().delete(id);
    waiting.resolve(status);
  }
  return request;
}
