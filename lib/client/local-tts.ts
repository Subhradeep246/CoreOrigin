/**
 * Text-to-speech, on-device only.
 *
 * Uses the browser's built-in `window.speechSynthesis`. No cloud TTS service,
 * no API key, no audio upload: the text stays in this tab and the audio is
 * produced by the operating system's own voices.
 *
 * If speech synthesis is missing or no matching voice exists, this degrades
 * silently — Voia is text-first, so speech is always an enhancement.
 */

import type { Language } from "@/lib/shared/types";

/** BCP-47 hints per supported language, in preference order. */
const VOICE_PREFERENCES: Record<Language, string[]> = {
  en: ["en-US", "en-GB", "en"],
  es: ["es-US", "es-ES", "es-MX", "es"],
};

const listeners = new Set<(speaking: boolean) => void>();

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function synth(): SpeechSynthesis | null {
  if (!isBrowser() || typeof window.speechSynthesis === "undefined") return null;
  return window.speechSynthesis;
}

/** True when this browser can speak locally. */
export function ttsSupported(): boolean {
  return synth() !== null && typeof window.SpeechSynthesisUtterance !== "undefined";
}

function emit(speaking: boolean): void {
  for (const fn of listeners) fn(speaking);
}

/** Subscribe to speaking start/stop. Returns an unsubscribe function. */
export function onSpeakingChange(cb: (speaking: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function pickVoice(voices: SpeechSynthesisVoice[], language: Language): SpeechSynthesisVoice | null {
  for (const tag of VOICE_PREFERENCES[language]) {
    const exact = voices.find((v) => v.lang.replace("_", "-").toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
  }
  const prefix = `${language}-`;
  const loose = voices.find((v) => {
    const lang = v.lang.replace("_", "-").toLowerCase();
    return lang === language || lang.startsWith(prefix);
  });
  return loose ?? null;
}

/**
 * Speak `text` in the given language. Cancels anything already being spoken so
 * prompts never overlap. Silently no-ops when unsupported or given empty text.
 */
export function speak(text: string, language: Language): void {
  const speech = synth();
  const trimmed = text.trim();
  if (!speech || !ttsSupported() || trimmed.length === 0) return;

  speech.cancel();

  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.lang = VOICE_PREFERENCES[language][0] ?? language;
  utterance.rate = 1;
  utterance.pitch = 1;

  // Voices load asynchronously in some browsers; an empty list is fine, the
  // platform default voice is used instead.
  const voice = pickVoice(speech.getVoices(), language);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  utterance.onstart = () => emit(true);
  utterance.onend = () => emit(false);
  utterance.onerror = () => emit(false);

  try {
    speech.speak(utterance);
  } catch {
    emit(false);
  }
}

/** Stop speaking immediately. */
export function stopSpeaking(): void {
  const speech = synth();
  if (!speech) return;
  try {
    speech.cancel();
  } finally {
    emit(false);
  }
}
