import { VOICE_PROVIDERS, isVoicePreference, pickVoiceProvider, type VoicePreference, type VoiceSettings } from "@gond/shared";
import { ensureDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { getProvider } from "./providers.ts";

export function getVoice(userId: string): VoiceSettings {
  const row = ensureDatabase().query("SELECT voice FROM gond_user_prefs WHERE user_id = ?").get(userId) as { voice: string | null } | null;
  const preference: VoicePreference = isVoicePreference(row?.voice) ? row.voice : "auto";
  const available = VOICE_PROVIDERS.filter((kind) => Boolean(getProvider(userId, kind)));
  return { preference, using: pickVoiceProvider(preference, (kind) => available.includes(kind)), available };
}

export function setVoice(userId: string, preference: VoicePreference): VoiceSettings {
  ensureDatabase()
    .query("INSERT INTO gond_user_prefs (user_id, voice, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET voice = excluded.voice, updated_at = excluded.updated_at")
    .run(userId, preference === "auto" ? null : preference, now());
  emit({ topic: "ai", userId });
  return getVoice(userId);
}
