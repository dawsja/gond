import { CALL_VOICE_ID, VOICE_PROVIDERS, isXaiUrl, type VoiceProvider, type VoiceSettings } from "@gond/shared";
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

function pickOf(id: string | null | undefined): string | null {
  return id?.trim() || null;
}

/** The person's picks as saved, null being the default; `speechModel` says what a job runs on now. */
export function getVoice(userId: string): VoiceSettings {
  const row = ensureDatabase().query("SELECT voice_model, call_voice, call_model FROM gond_user_prefs WHERE user_id = ?").get(userId) as Row | null;
  return { using: voiceProvider(userId), transcribeModel: pickOf(row?.voice_model), callModel: pickOf(row?.call_model), callVoice: callVoiceOf(row?.call_voice) };
}

/** Null or empty puts a job back on the default, so it moves to each newer model the key offers; the route checks a pick first. */
export function setVoice(userId: string, patch: { transcribeModel?: string | null; callModel?: string | null }): VoiceSettings {
  const db = ensureDatabase();
  if (patch.transcribeModel !== undefined) {
    db.query("INSERT INTO gond_user_prefs (user_id, voice_model, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET voice_model = excluded.voice_model, updated_at = excluded.updated_at").run(
      userId,
      pickOf(patch.transcribeModel),
      now(),
    );
  }
  if (patch.callModel !== undefined) {
    db.query("INSERT INTO gond_user_prefs (user_id, call_model, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET call_model = excluded.call_model, updated_at = excluded.updated_at").run(
      userId,
      pickOf(patch.callModel),
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
