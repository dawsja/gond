import { CALL_VOICE_ID, VOICE_MODELS, VOICE_PROVIDERS, isXaiUrl, type VoiceProvider, type VoiceSettings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { providerBaseUrl } from "./providers.ts";

type Row = { voice_model: string | null; call_voice: string | null };

function callVoiceOf(raw: string | null | undefined): VoiceSettings["callVoice"] {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([kind, id]) => (VOICE_PROVIDERS as readonly string[]).includes(kind) && typeof id === "string" && CALL_VOICE_ID.test(id)));
  } catch {
    return {};
  }
}

/** Whose speech endpoints the person's OpenAI-compatible key reaches; null without one. */
function voiceProvider(userId: string): VoiceProvider | null {
  const baseUrl = providerBaseUrl(userId, "openai");
  return baseUrl ? (isXaiUrl(baseUrl) ? "xai" : "openai") : null;
}

export function getVoice(userId: string): VoiceSettings {
  const row = ensureDatabase().query("SELECT voice_model, call_voice FROM gond_user_prefs WHERE user_id = ?").get(userId) as Row | null;
  return { using: voiceProvider(userId), openaiModel: row?.voice_model || VOICE_MODELS.openai.model, callVoice: callVoiceOf(row?.call_voice) };
}

/** An empty `openaiModel` puts OpenAI's own model back. */
export function setVoice(userId: string, patch: { openaiModel: string }): VoiceSettings {
  const model = patch.openaiModel.trim() || VOICE_MODELS.openai.model;
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, voice_model, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET voice_model = excluded.voice_model, updated_at = excluded.updated_at")
    .run(userId, model === VOICE_MODELS.openai.model ? null : model, now());
  emit({ topic: "ai", userId });
  return getVoice(userId);
}

/** The voice a call on this provider speaks in; null puts the provider's own default back. */
export function setCallVoice(userId: string, provider: VoiceProvider, id: string | null): VoiceSettings {
  const voices = { ...getVoice(userId).callVoice };
  if (id) voices[provider] = id;
  else delete voices[provider];
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, call_voice, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET call_voice = excluded.call_voice, updated_at = excluded.updated_at")
    .run(userId, JSON.stringify(voices), now());
  emit({ topic: "ai", userId });
  return getVoice(userId);
}
