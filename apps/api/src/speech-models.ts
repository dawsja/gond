import { SPEECH_FAMILIES, VOICE_MODEL_ID, chosenModel, speechModels, type SpeechJob, type VoiceModelList, type VoiceProvider } from "@gond/shared";
import { providerBaseUrl, providerKey } from "./data/providers.ts";
import { getVoice } from "./data/voice.ts";
import { authHeaders, upstreamUrl } from "./providers.ts";

const LIST_MS = 10 * 60_000;
const lists = new Map<string, { at: number; ids: string[] | null }>();

/** The model ids the key's server lists, or null when it won't say; kept ten minutes, so a new model shows within that. */
export async function listedModels(baseUrl: string, key: string): Promise<string[] | null> {
  const cacheKey = `${baseUrl}\n${key}`;
  const cached = lists.get(cacheKey);
  if (cached && Date.now() - cached.at < LIST_MS) return cached.ids;
  const res = await fetch(upstreamUrl(baseUrl, "models", ""), { headers: authHeaders("voice", baseUrl, key), redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const payload = res?.ok ? ((await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null) : null;
  const ids = payload?.data ? payload.data.flatMap((model) => (typeof model.id === "string" && VOICE_MODEL_ID.test(model.id) ? [model.id] : [])) : null;
  lists.set(cacheKey, { at: Date.now(), ids });
  return ids;
}

export type VoiceAccess = { provider: VoiceProvider; baseUrl: string; key: string; own: boolean };

/** The person's voice key and whose it is; `own` is an OpenAI-compatible server that isn't OpenAI's. */
export function voiceAccess(userId: string): VoiceAccess | null {
  const provider = getVoice(userId).using;
  const baseUrl = provider ? providerBaseUrl(userId, "voice") : null;
  const key = provider ? providerKey(userId, "voice") : null;
  if (!provider || !baseUrl || !key) return null;
  let own = false;
  try {
    own = provider === "openai" && new URL(baseUrl).hostname.toLowerCase() !== "api.openai.com";
  } catch {
    own = true;
  }
  return { provider, baseUrl, key, own };
}

function isFamilyModel(provider: VoiceProvider, id: string): boolean {
  return Object.values(SPEECH_FAMILIES[provider]).some((families) => families.some(({ pattern }) => pattern.test(id)));
}

export function voiceModelsFrom(provider: VoiceProvider, listed: string[] | null, own: boolean, picks: { call: string | null; transcribe: string | null }): VoiceModelList {
  const job = (name: SpeechJob) => ({ ...speechModels(provider, name, listed), chosen: chosenModel(provider, name, picks[name], listed, own) });
  return { call: job("call"), transcribe: job("transcribe"), others: own && listed ? listed.filter((id) => !isFamilyModel(provider, id)) : [], own };
}

export async function voiceModelsFor(userId: string, access: VoiceAccess): Promise<VoiceModelList> {
  const voice = getVoice(userId);
  return voiceModelsFrom(access.provider, await listedModels(access.baseUrl, access.key), access.own, { call: voice.callModel, transcribe: voice.transcribeModel });
}

/** The model a job runs on now: the person's pick while the key offers it, else the newest it does. */
export async function speechModel(userId: string, job: SpeechJob, access: VoiceAccess): Promise<string> {
  const voice = getVoice(userId);
  return chosenModel(access.provider, job, job === "call" ? voice.callModel : voice.transcribeModel, await listedModels(access.baseUrl, access.key), access.own);
}

/** Whether a pick may be saved: one the key offers, or on a server of the person's own, any id for the microphone and a family's for calls. */
export async function canPick(access: VoiceAccess, job: SpeechJob, id: string): Promise<boolean> {
  if (!VOICE_MODEL_ID.test(id)) return false;
  if (access.own && job === "transcribe") return true;
  const listed = await listedModels(access.baseUrl, access.key);
  const offered = speechModels(access.provider, job, listed).groups.some((group) => group.models.includes(id));
  return offered || (access.own && SPEECH_FAMILIES[access.provider][job].some(({ pattern }) => pattern.test(id)));
}
