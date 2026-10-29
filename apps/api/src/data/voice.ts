import { CALL_MODELS, CALL_VOICE_ID, OPENAI_CALL_MODELS, OPENAI_TRANSCRIBE_MODELS, VOICE_MODELS, VOICE_PROVIDERS, isRetired, isXaiUrl, type VoiceProvider, type VoiceSettings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { providerBaseUrl } from "./providers.ts";

type Row = { voice_model: string | null; call_voice: string | null; call_model: string | null };

function callVoiceOf(raw: string | null | undefined): VoiceSettings["callVoice"] {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([kind, id]) => (VOICE_PROVIDERS as readonly string[]).includes(kind) && typeof id === "string" && CALL_VOICE_ID.test(id)));
  } catch {
    return {};
  }
}

/** Whose speech endpoints the person's voice key reaches; null without one. */
function voiceProvider(userId: string): VoiceProvider | null {
  const baseUrl = providerBaseUrl(userId, "voice");
  return baseUrl ? (isXaiUrl(baseUrl) ? "xai" : "openai") : null;
}

/** A picked model OpenAI has since shut down reads as the recommended one, so the microphone and calls keep working. */
function transcribeModel(id: string | null | undefined): string {
  const known = OPENAI_TRANSCRIBE_MODELS.find((model) => model.id === id);
  return id && !(known && isRetired(known)) ? id : VOICE_MODELS.openai.model;
}

function callModel(id: string | null | undefined): string {
  const known = OPENAI_CALL_MODELS.find((model) => model.id === id);
  return known && !isRetired(known) ? known.id : CALL_MODELS.openai.model;
}

export function getVoice(userId: string): VoiceSettings {
  const row = ensureDatabase().query("SELECT voice_model, call_voice, call_model FROM gond_user_prefs WHERE user_id = ?").get(userId) as Row | null;
  return { using: voiceProvider(userId), openaiModel: transcribeModel(row?.voice_model), callModel: callModel(row?.call_model), callVoice: callVoiceOf(row?.call_voice) };
}

/** An empty `openaiModel` puts OpenAI's own model back; a `callModel` must be one of `OPENAI_CALL_MODELS`. */
export function setVoice(userId: string, patch: { openaiModel?: string; callModel?: string }): VoiceSettings {
  const db = ensureDatabase();
  if (patch.openaiModel !== undefined) {
    const model = patch.openaiModel.trim() || VOICE_MODELS.openai.model;
    db.query("INSERT INTO gond_user_prefs (user_id, voice_model, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET voice_model = excluded.voice_model, updated_at = excluded.updated_at").run(
      userId,
      model === VOICE_MODELS.openai.model ? null : model,
      now(),
    );
  }
  if (patch.callModel !== undefined) {
    const model = callModel(patch.callModel);
    db.query("INSERT INTO gond_user_prefs (user_id, call_model, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET call_model = excluded.call_model, updated_at = excluded.updated_at").run(
      userId,
      model === CALL_MODELS.openai.model ? null : model,
      now(),
    );
  }
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
