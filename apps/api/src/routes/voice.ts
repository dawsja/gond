import { CALL_MODELS, CALL_VOICE_ID, TRANSCRIBE_MAX_BYTES, VOICE_MODELS, openAiCallVoices, type CallVoice, type SpeechJob, type VoiceProvider } from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { ownThread, userId } from "../access.ts";
import { getBot } from "../data/bots.ts";
import { providerBaseUrl, providerKey } from "../data/providers.ts";
import { getVoice, setCallVoice, setVoice } from "../data/voice.ts";
import { canPick, speechModel, voiceAccess, voiceModelsFor } from "../speech-models.ts";
import { authHeaders, upstreamUrl } from "../providers.ts";
import { readBody } from "./body.ts";

// Both APIs read the format from the file name, and Bun's multipart parser drops a part's own
// type for one guessed from the name, so the name's extension is what counts.
const EXTENSIONS = new Set(["webm", "mp4", "m4a", "mp3", "mpeg", "wav", "ogg"]);

function audioExtension(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && EXTENSIONS.has(extension) ? extension : null;
}

const VOICE_LIST_MS = 10 * 60_000;
const SAMPLE_TEXT = "Hi, it's your bot. This is how I'll sound when you call me.";
const voiceLists = new Map<string, { at: number; voices: CallVoice[] }>();

/** xAI says which voices it has; OpenAI has no list to ask, so its are written down in shared, per call model. */
async function voicesFor(provider: VoiceProvider, baseUrl: string, key: string, callModel: string): Promise<CallVoice[] | null> {
  if (provider === "openai") return openAiCallVoices(callModel);
  const cacheKey = `${baseUrl}\n${key}`;
  const cached = voiceLists.get(cacheKey);
  if (cached && Date.now() - cached.at < VOICE_LIST_MS) return cached.voices;
  const res = await fetch(upstreamUrl(baseUrl, "tts/voices", ""), { headers: authHeaders("voice", baseUrl, key), redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  const payload = (await res.json().catch(() => null)) as { voices?: { voice_id?: unknown; name?: unknown }[] } | null;
  const voices = (payload?.voices ?? [])
    .filter((v) => typeof v.voice_id === "string" && CALL_VOICE_ID.test(v.voice_id))
    .map((v) => ({ id: v.voice_id as string, name: typeof v.name === "string" && v.name ? v.name : (v.voice_id as string), detail: null }));
  voiceLists.set(cacheKey, { at: Date.now(), voices });
  return voices;
}

export function voiceRoutes() {
  const app = new Hono<Env>();

  app.get("/voice", (c) => c.json(getVoice(userId(c))));

  app.put("/voice", async (c) => {
    const who = userId(c);
    const body = await readBody(c);
    const picks: [SpeechJob, unknown][] = [
      ["transcribe", body.transcribeModel],
      ["call", body.callModel],
    ];
    const given = picks.filter(([, id]) => id !== undefined);
    if (!given.length) return c.json({ error: "There was nothing to change" }, 400);
    const access = voiceAccess(who);
    if (!access) return c.json({ error: "Add a voice key in Settings → Voice first" }, 409);
    const patch: { transcribeModel?: string | null; callModel?: string | null } = {};
    for (const [job, id] of given) {
      if (id !== null && typeof id !== "string") return c.json({ error: "That isn't a model id" }, 400);
      const pick = id?.trim() || null;
      if (pick && !(await canPick(access, job, pick))) return c.json({ error: job === "call" ? "Calls can't run on that model" : "Your key doesn't offer that model" }, 400);
      patch[job === "call" ? "callModel" : "transcribeModel"] = pick;
    }
    return c.json(setVoice(who, patch));
  });

  app.get("/voice/models", async (c) => {
    const who = userId(c);
    const access = voiceAccess(who);
    if (!access) return c.json({ error: "Add a voice key in Settings → Voice first" }, 409);
    return c.json(await voiceModelsFor(who, access));
  });

  app.get("/voice/voices", async (c) => {
    const who = userId(c);
    const access = voiceAccess(who);
    if (!access) return c.json({ provider: null, voices: [], chosen: null });
    const { provider, baseUrl, key } = access;
    const voices = await voicesFor(provider, baseUrl, key, provider === "openai" ? await speechModel(who, "call", access) : "");
    if (!voices) return c.json({ error: `${VOICE_MODELS[provider].label} didn't list its voices. Try again.` }, 502);
    const picked = getVoice(who).callVoice[provider];
    return c.json({ provider, voices, chosen: picked && voices.some((v) => v.id === picked) ? picked : CALL_MODELS[provider].voice });
  });

  app.put("/voice/call-voice", async (c) => {
    const who = userId(c);
    const body = await readBody(c);
    const provider = getVoice(who).using;
    if (!provider) return c.json({ error: "Add a voice key in Settings → Voice first" }, 409);
    if (body.voice !== null && (typeof body.voice !== "string" || !CALL_VOICE_ID.test(body.voice))) return c.json({ error: "That isn't a voice" }, 400);
    return c.json(setCallVoice(who, provider, body.voice === CALL_MODELS[provider].voice ? null : body.voice));
  });

  // A short sample of a voice, said by the provider's own speech with the person's key, so a pick isn't blind.
  app.get("/voice/sample", async (c) => {
    const who = userId(c);
    const id = c.req.query("voice") ?? "";
    if (!CALL_VOICE_ID.test(id)) return c.json({ error: "That isn't a voice" }, 400);
    const provider = getVoice(who).using;
    const baseUrl = provider ? providerBaseUrl(who, "voice") : null;
    const key = provider ? providerKey(who, "voice") : null;
    if (!provider || !baseUrl || !key) return c.json({ error: "Add a voice key in Settings → Voice first" }, 409);
    const request =
      provider === "xai"
        ? { path: "tts", body: { text: SAMPLE_TEXT, voice_id: id, language: "en" } }
        : { path: "audio/speech", body: { model: "gpt-4o-mini-tts", voice: id, input: SAMPLE_TEXT, response_format: "mp3" } };
    const res = await fetch(upstreamUrl(baseUrl, request.path, ""), {
      method: "POST",
      headers: { ...authHeaders("voice", baseUrl, key), "content-type": "application/json" },
      body: JSON.stringify(request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res?.ok) return c.json({ error: "There's no sample of that voice." }, 502);
    return new Response(await res.arrayBuffer(), { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });
  });

  app.post("/transcribe", async (c) => {
    const who = userId(c);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the recording as a file" }, 400);
    const extension = audioExtension(file.name);
    if (!extension) return c.json({ error: "That isn't a recording this can read" }, 400);
    if (file.size > TRANSCRIBE_MAX_BYTES) return c.json({ error: "The recording is too long" }, 413);
    const access = voiceAccess(who);
    if (!access) return c.json({ error: "Add a voice key in Settings → Voice to talk to your bots" }, 409);
    const { provider: kind, baseUrl, key } = access;

    const { path, label } = VOICE_MODELS[kind];
    const model = await speechModel(who, "transcribe", access);
    const upstream = new FormData();
    upstream.set("model", model);
    upstream.set("file", file, `recording.${extension}`);
    const threadId = form?.get("threadId");
    const thread = typeof threadId === "string" ? ownThread(c, threadId) : null;
    // Of OpenAI's models only GPT Transcribe takes hints; a server of the person's own may use them.
    const hints = access.own || /^gpt-transcribe/.test(model);
    if (thread && kind === "openai" && hints) {
      const names = new Set([...thread.members, thread.botId].flatMap((id) => (id ? [getBot(id)?.name] : [])));
      for (const name of names) if (name && !/[<>\r\n]/.test(name)) upstream.append("keywords[]", name);
    }

    let res: Response;
    try {
      res = await fetch(upstreamUrl(baseUrl, path, ""), { method: "POST", headers: authHeaders("voice", baseUrl, key), body: upstream, redirect: "manual", signal: AbortSignal.timeout(60_000) });
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
