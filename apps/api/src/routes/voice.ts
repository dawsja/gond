import {
  CALL_MODELS,
  CALL_VOICE_ID,
  OPENAI_CALL_MODELS,
  OPENAI_TRANSCRIBE_MODELS,
  TRANSCRIBE_MAX_BYTES,
  VOICE_MODEL_ID,
  VOICE_MODELS,
  isRetired,
  openAiCallVoices,
  type CallVoice,
  type VoiceModel,
  type VoiceModelList,
  type VoiceProvider,
} from "@gond/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { ownThread, userId } from "../access.ts";
import { getBot } from "../data/bots.ts";
import { providerBaseUrl, providerKey } from "../data/providers.ts";
import { getVoice, setCallVoice, setVoice } from "../data/voice.ts";
import { authHeaders, upstreamUrl } from "../providers.ts";

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

const modelLists = new Map<string, { at: number; ids: string[] | null }>();

/** The model ids the key's server lists, or null when it won't say. */
async function listedModels(baseUrl: string, key: string): Promise<string[] | null> {
  const cacheKey = `${baseUrl}\n${key}`;
  const cached = modelLists.get(cacheKey);
  if (cached && Date.now() - cached.at < VOICE_LIST_MS) return cached.ids;
  const res = await fetch(upstreamUrl(baseUrl, "models", ""), { headers: authHeaders("voice", baseUrl, key), redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const payload = res?.ok ? ((await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null) : null;
  const ids = payload?.data ? payload.data.flatMap((model) => (typeof model.id === "string" && VOICE_MODEL_ID.test(model.id) ? [model.id] : [])) : null;
  modelLists.set(cacheKey, { at: Date.now(), ids });
  return ids;
}

function isOpenAi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

const described = ({ id, name, about, price, recommended, retires }: VoiceModel): VoiceModel => ({ id, name, about, price, ...(recommended ? { recommended } : {}), ...(retires ? { retires } : {}) });

/**
 * The catalog's models the key's server lists, all of them when it lists none of them (or won't say), and
 * a server of the person's own its other ids, since only they know what it serves.
 */
export function voiceModelsFrom(listed: string[] | null, openAi: boolean): VoiceModelList {
  const offer = (catalog: VoiceModel[]) => {
    const live = catalog.filter((model) => !isRetired(model));
    const known = listed ? live.filter((model) => listed.includes(model.id)) : [];
    return (known.length ? known : live).map(described);
  };
  const catalog = new Set([...OPENAI_TRANSCRIBE_MODELS, ...OPENAI_CALL_MODELS].map((model) => model.id));
  return { transcribe: offer(OPENAI_TRANSCRIBE_MODELS), call: offer(OPENAI_CALL_MODELS), others: openAi || !listed ? [] : listed.filter((id) => !catalog.has(id)) };
}

export function voiceRoutes() {
  const app = new Hono<Env>();

  app.get("/voice", (c) => c.json(getVoice(userId(c))));

  app.put("/voice", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { openaiModel?: unknown; callModel?: unknown } | null;
    const { openaiModel, callModel } = body ?? {};
    if (openaiModel === undefined && callModel === undefined) return c.json({ error: "There was nothing to change" }, 400);
    if (openaiModel !== undefined && (typeof openaiModel !== "string" || (openaiModel.trim() && !VOICE_MODEL_ID.test(openaiModel.trim())))) return c.json({ error: "That isn't a model id" }, 400);
    const call = OPENAI_CALL_MODELS.find((model) => model.id === callModel);
    if (callModel !== undefined && (!call || isRetired(call))) return c.json({ error: "Calls can't run on that model" }, 400);
    return c.json(setVoice(userId(c), { openaiModel: openaiModel as string | undefined, callModel: call?.id }));
  });

  app.get("/voice/models", async (c) => {
    const who = userId(c);
    const baseUrl = getVoice(who).using === "openai" ? providerBaseUrl(who, "voice") : null;
    const key = baseUrl ? providerKey(who, "voice") : null;
    if (!baseUrl || !key) return c.json({ transcribe: [], call: [], others: [] } satisfies VoiceModelList);
    return c.json(voiceModelsFrom(await listedModels(baseUrl, key), isOpenAi(baseUrl)));
  });

  app.get("/voice/voices", async (c) => {
    const who = userId(c);
    const voice = getVoice(who);
    const provider = voice.using;
    const baseUrl = provider ? providerBaseUrl(who, "voice") : null;
    const key = provider ? providerKey(who, "voice") : null;
    if (!provider || !baseUrl || !key) return c.json({ provider: null, voices: [], chosen: null });
    const voices = await voicesFor(provider, baseUrl, key, voice.callModel);
    if (!voices) return c.json({ error: `${VOICE_MODELS[provider].label} didn't list its voices. Try again.` }, 502);
    const picked = voice.callVoice[provider];
    return c.json({ provider, voices, chosen: picked && voices.some((v) => v.id === picked) ? picked : CALL_MODELS[provider].voice });
  });

  app.put("/voice/call-voice", async (c) => {
    const who = userId(c);
    const body = (await c.req.json().catch(() => null)) as { voice?: unknown } | null;
    const provider = getVoice(who).using;
    if (!provider) return c.json({ error: "Add a voice key in Settings → Voice first" }, 409);
    if (body?.voice !== null && (typeof body?.voice !== "string" || !CALL_VOICE_ID.test(body.voice))) return c.json({ error: "That isn't a voice" }, 400);
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
    const voice = getVoice(who);
    const kind = voice.using;
    const baseUrl = kind ? providerBaseUrl(who, "voice") : null;
    const key = kind ? providerKey(who, "voice") : null;
    if (!kind || !baseUrl || !key) return c.json({ error: "Add a voice key in Settings → Voice to talk to your bots" }, 409);

    const { path, label } = VOICE_MODELS[kind];
    const model = kind === "openai" ? voice.openaiModel : VOICE_MODELS[kind].model;
    const upstream = new FormData();
    upstream.set("model", model);
    upstream.set("file", file, `recording.${extension}`);
    const threadId = form?.get("threadId");
    const thread = typeof threadId === "string" ? ownThread(c, threadId) : null;
    // Only GPT Transcribe of OpenAI's models takes hints; a server of the person's own may use them.
    const hints = OPENAI_TRANSCRIBE_MODELS.find((candidate) => candidate.id === model)?.hints ?? true;
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
