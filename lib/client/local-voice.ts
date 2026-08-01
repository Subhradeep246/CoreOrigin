/**
 * OPTIONAL voice input. Text-first is the default experience.
 *
 * HARD RULES — these are product requirements, not preferences:
 *  1. `start()` throws unless it is handed `{ cloudVoiceConsent: true }`. There
 *     is no implicit consent and no remembered consent inside this module.
 *  2. The microphone is only ever opened from an explicit, user-initiated call.
 *     Nothing here auto-starts, polls, or pre-warms the mic.
 *  3. NO voice anomaly detection. NO disease or condition inference. NO acoustic
 *     analysis of any kind — no pitch, jitter, shimmer, formant, prosody,
 *     breathing, cough, or emotion analysis. Voia is a booking assistant, not a
 *     screener. This file must never grow such a feature.
 *  4. Raw audio is never stored: not in memory beyond the live stream, not in
 *     IndexedDB, not on disk, and it is never uploaded anywhere other than the
 *     configured Google AI path the patient consented to.
 *  5. Transcripts are not retained. Each result is handed to the callback and
 *     dropped; this module keeps no history buffer.
 *  6. If audio is unavailable or denied, we surface a text-only fallback error.
 *     We never silently fall back to a different cloud voice provider.
 *
 * `stop()` releases every media track so the browser's recording indicator goes
 * away immediately.
 */

import type { Language } from "@/lib/shared/types";

/** Consent token that must be passed explicitly on every `start()`. */
export type CloudVoiceConsent = { cloudVoiceConsent: boolean };

export type VoiceCaptureOptions = {
  language?: Language;
  /** Emit partial results while the patient is still talking. */
  interimResults?: boolean;
};

/* ------------------------------------------------------------------ */
/* Minimal Web Speech API typings (no `any`)                           */
/* ------------------------------------------------------------------ */

type SpeechAlternative = { transcript: string; confidence: number };

type SpeechResult = {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechAlternative;
  [index: number]: SpeechAlternative;
};

type SpeechResultList = {
  readonly length: number;
  item(index: number): SpeechResult;
  [index: number]: SpeechResult;
};

type SpeechResultEvent = {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
};

type SpeechErrorEvent = { readonly error: string; readonly message?: string };

interface VoiaSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => VoiaSpeechRecognition;

type SpeechCapableWindow = {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

const LANG_TAG: Record<Language, string> = { en: "en-US", es: "es-US" };

const TEXT_FALLBACK =
  "Voice input is not available. You can type your answer instead — everything works without the microphone.";

const MIC_DENIED =
  "Microphone access was blocked. You can type your answer instead — everything works without the microphone.";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (!isBrowser()) return null;
  const w = window as unknown as SpeechCapableWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser exposes both speech recognition and a microphone API. */
export function micSupported(): boolean {
  if (!isBrowser()) return false;
  const hasMedia =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function";
  return recognitionCtor() !== null && hasMedia;
}

/**
 * One capture session. Create it in a click handler, `start()` it with explicit
 * consent, and `stop()` it as soon as the answer is captured.
 */
export class VoiceCapture {
  #recognition: VoiaSpeechRecognition | null = null;

  #stream: MediaStream | null = null;

  #transcriptCbs = new Set<(text: string, isFinal: boolean) => void>();

  #errorCbs = new Set<(message: string) => void>();

  #active = false;

  readonly #language: Language;

  readonly #interim: boolean;

  constructor(options: VoiceCaptureOptions = {}) {
    this.#language = options.language ?? "en";
    this.#interim = options.interimResults ?? false;
  }

  /** Transcripts are passed here and immediately forgotten by this class. */
  onTranscript(cb: (text: string, isFinal: boolean) => void): () => void {
    this.#transcriptCbs.add(cb);
    return () => {
      this.#transcriptCbs.delete(cb);
    };
  }

  /** Errors are plain patient-facing strings pointing back to typing. */
  onError(cb: (message: string) => void): () => void {
    this.#errorCbs.add(cb);
    return () => {
      this.#errorCbs.delete(cb);
    };
  }

  get active(): boolean {
    return this.#active;
  }

  /**
   * Begin listening. MUST be called from a user gesture (button press).
   *
   * Throws synchronously when consent is missing or voice is unsupported, so a
   * caller can never accidentally open the microphone.
   */
  start(consent: CloudVoiceConsent): void {
    if (!consent || consent.cloudVoiceConsent !== true) {
      // Rule 1: no consent, no microphone. Not recoverable at runtime.
      throw new Error("Microphone use requires explicit voice consent");
    }
    if (!isBrowser()) {
      throw new Error("Voice input is only available in the browser");
    }
    if (!micSupported()) {
      throw new Error(TEXT_FALLBACK);
    }
    if (this.#active) return;
    this.#active = true;
    // Fire-and-forget: async failures surface through onError, never as an
    // unhandled rejection, and never as a switch to another provider.
    void this.#begin();
  }

  async #begin(): Promise<void> {
    try {
      // Explicit permission prompt, tied to the user's click.
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.#active = false;
      this.#emitError(TEXT_FALLBACK);
      return;
    }

    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.#releaseStream();
      this.#active = false;
      this.#emitError(TEXT_FALLBACK);
      return;
    }

    const recognition = new Ctor();
    recognition.lang = LANG_TAG[this.#language];
    recognition.continuous = false;
    recognition.interimResults = this.#interim;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result || result.length === 0) continue;
        const alternative = result[0];
        const text = alternative ? alternative.transcript.trim() : "";
        if (text.length === 0) continue;
        // Hand off and drop. Nothing is accumulated or persisted here.
        this.#emitTranscript(text, result.isFinal);
      }
    };

    recognition.onerror = (event) => {
      const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
      this.#emitError(denied ? MIC_DENIED : TEXT_FALLBACK);
      this.stop();
    };

    recognition.onend = () => {
      this.#active = false;
      this.#releaseStream();
    };

    this.#recognition = recognition;

    try {
      recognition.start();
    } catch {
      this.#active = false;
      this.#releaseStream();
      this.#emitError(TEXT_FALLBACK);
    }
  }

  /** Stop listening and release the microphone immediately. */
  stop(): void {
    this.#active = false;
    const recognition = this.#recognition;
    this.#recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    }
    this.#releaseStream();
  }

  #releaseStream(): void {
    const stream = this.#stream;
    this.#stream = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Track already ended.
      }
    }
  }

  #emitTranscript(text: string, isFinal: boolean): void {
    for (const cb of this.#transcriptCbs) cb(text, isFinal);
  }

  #emitError(message: string): void {
    for (const cb of this.#errorCbs) cb(message);
  }
}
