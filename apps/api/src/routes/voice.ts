import { TRANSCRIBE_MAX_BYTES, VOICE_MODEL_ID, VOICE_MODELS, isVoicePreference } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { ownThread, userId } from "../access.ts";
import { getBot } from "../data/bots.ts";
import { providerBaseUrl, providerKey } from "../data/providers.ts";
import { getVoice, setVoice } from "../data/voice.ts";
import { authHeaders, upstreamUrl } from "./llm.ts";

// Both APIs read the format from the file name, and Bun's multipart parser drops a part's own
// type for one guessed from the name, so the name's extension is what counts.
const EXTENSIONS = new Set(["webm", "mp4", "m4a", "mp3", "mpeg", "wav", "ogg"]);

export function audioExtension(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && EXTENSIONS.has(extension) ? extension : null;
}

export function voiceRoutes() {
  const app = new Hono<Env>();

  app.get("/voice", (c) => c.json(getVoice(userId(c))));

  app.put("/voice", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { preference?: unknown; openaiModel?: unknown } | null;
    const { preference, openaiModel } = body ?? {};
    if (preference === undefined && openaiModel === undefined) return c.json({ error: "There was nothing to change" }, 400);
    if (preference !== undefined && !isVoicePreference(preference)) return c.json({ error: "Pick Automatic, xAI or OpenAI" }, 400);
    if (openaiModel !== undefined && (typeof openaiModel !== "string" || (openaiModel.trim() && !VOICE_MODEL_ID.test(openaiModel.trim())))) return c.json({ error: "That isn't a model id" }, 400);
    return c.json(setVoice(userId(c), { preference, openaiModel }));
  });

  app.post("/transcribe", async (c) => {
    const who = userId(c);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the recording as a file" }, 400);
    const extension = audioExtension(file.name);
    if (!extension) return c.json({ error: "That isn't a recording this can read" }, 400);
    if (file.size > TRANSCRIBE_MAX_BYTES) return c.json({ error: "The recording is too long" }, 413);
    const voice = getVoice(who);
    const kind = voice.using;
    const baseUrl = kind ? providerBaseUrl(who, kind) : null;
    const key = kind ? providerKey(who, kind) : null;
    if (!kind || !baseUrl || !key) return c.json({ error: "Add an xAI or OpenAI key to talk to your bots" }, 409);

    const { path, label } = VOICE_MODELS[kind];
    const model = kind === "openai" ? voice.openaiModel : VOICE_MODELS[kind].model;
    const upstream = new FormData();
    upstream.set("model", model);
    upstream.set("file", file, `recording.${extension}`);
    const threadId = form?.get("threadId");
    const thread = typeof threadId === "string" ? ownThread(c, threadId) : null;
    if (thread && kind === "openai") {
      const names = new Set([...thread.members, thread.botId].flatMap((id) => (id ? [getBot(id)?.name] : [])));
      for (const name of names) if (name && !/[<>\r\n]/.test(name)) upstream.append("keywords[]", name);
    }

    let res: Response;
    try {
      res = await fetch(upstreamUrl(baseUrl, path, ""), { method: "POST", headers: authHeaders(kind, baseUrl, key), body: upstream, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch {
      return c.json({ error: `${label} didn't answer. Try again.` }, 502);
    }
    if (res.status === 401 || res.status === 403) return c.json({ error: `${label} refused your key` }, 422);
    if (res.status >= 400 && res.status < 500) return c.json({ error: `${label} couldn't transcribe that` }, 422);
    if (!res.ok) return c.json({ error: `${label} answered ${res.status}. Try again.` }, 502);
    const payload = (await res.json().catch(() => null)) as { text?: unknown } | null;
    return c.json({ text: typeof payload?.text === "string" ? payload.text.trim() : "" });
  });

  return app;
}
