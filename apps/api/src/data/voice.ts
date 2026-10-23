import { CALL_VOICE_ID, VOICE_MODELS, VOICE_PROVIDERS, type VoiceProvider, isVoicePreference, pickVoiceProvider, type VoicePreference, type VoiceSettings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { getProvider } from "./providers.ts";

type Row = { voice: string | null; voice_model: string | null; call_voice: string | null };

function callVoiceOf(raw: string | null | undefined): VoiceSettings["callVoice"] {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([kind, id]) => (VOICE_PROVIDERS as readonly string[]).includes(kind) && typeof id === "string" && CALL_VOICE_ID.test(id)));
  } catch {
    return {};
  }
}

export function getVoice(userId: string): VoiceSettings {
  const row = ensureDatabase().query("SELECT voice, voice_model, call_voice FROM gond_user_prefs WHERE user_id = ?").get(userId) as Row | null;
  const preference: VoicePreference = isVoicePreference(row?.voice) ? row.voice : "auto";
  const available = VOICE_PROVIDERS.filter((kind) => Boolean(getProvider(userId, kind)));
  return { preference, using: pickVoiceProvider(preference, (kind) => available.includes(kind)), available, openaiModel: row?.voice_model || VOICE_MODELS.openai.model, callVoice: callVoiceOf(row?.call_voice) };
}

/** An empty `openaiModel` puts OpenAI's own model back. */
export function setVoice(userId: string, patch: { preference?: VoicePreference; openaiModel?: string }): VoiceSettings {
  const current = getVoice(userId);
  const preference = patch.preference ?? current.preference;
  const model = patch.openaiModel === undefined ? current.openaiModel : patch.openaiModel.trim() || VOICE_MODELS.openai.model;
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, voice, voice_model, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET voice = excluded.voice, voice_model = excluded.voice_model, updated_at = excluded.updated_at")
    .run(userId, preference === "auto" ? null : preference, model === VOICE_MODELS.openai.model ? null : model, now());
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
