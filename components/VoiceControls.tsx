"use client";

/**
 * VoiceControls — entirely optional. Voia is text-first and must work with this
 * component removed from the tree.
 *
 * Two independent controls:
 *  1. Speaker: reads assistant messages aloud using the operating system's own
 *     voices (`lib/client/local-tts`). Nothing leaves the device.
 *  2. Microphone: DISABLED until cloud-voice consent is granted in the vault.
 *     The consent copy is shown before first use. The mic never auto-starts —
 *     it only ever opens from this button's click handler.
 *
 * There is no acoustic analysis here of any kind. Transcripts are handed to the
 * parent and dropped; no audio or transcript is stored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { localProfile, touch } from "@/lib/client/local-profile";
import { onSpeakingChange, speak, stopSpeaking, ttsSupported } from "@/lib/client/local-tts";
import { VoiceCapture, micSupported } from "@/lib/client/local-voice";
import { useLanguage, useLocalProfile } from "./AppShell";

const COPY = {
  en: {
    heading: "Voice (optional)",
    readAloud: "Read replies aloud",
    stopReading: "Stop reading aloud",
    speaking: "Speaking…",
    ttsUnsupported: "This browser cannot read text aloud. Everything still works as text.",
    micUnsupported:
      "Voice input is not available in this browser. You can type your answer instead — everything works without the microphone.",
    consentCopy:
      "Voice mode sends your audio or transcription to Google's AI service. Audio is not stored by Voia.",
    grant: "Turn on voice mode",
    micStart: "Start microphone",
    micStop: "Stop microphone",
    listening: "Listening. Speak your answer, then stop the microphone.",
    micDisabled: "Turn on voice mode to enable the microphone.",
    granting: "Saving…",
  },
  es: {
    heading: "Voz (opcional)",
    readAloud: "Leer las respuestas en voz alta",
    stopReading: "Dejar de leer en voz alta",
    speaking: "Hablando…",
    ttsUnsupported: "Este navegador no puede leer en voz alta. Todo sigue funcionando como texto.",
    micUnsupported:
      "La entrada por voz no está disponible en este navegador. Puede escribir su respuesta: todo funciona sin el micrófono.",
    consentCopy:
      "Voice mode sends your audio or transcription to Google's AI service. Audio is not stored by Voia.",
    grant: "Activar el modo de voz",
    micStart: "Iniciar micrófono",
    micStop: "Detener micrófono",
    listening: "Escuchando. Diga su respuesta y luego detenga el micrófono.",
    micDisabled: "Active el modo de voz para habilitar el micrófono.",
    granting: "Guardando…",
  },
} as const;

export type VoiceControlsProps = {
  /** Latest assistant message, spoken when the speaker toggle is on. */
  latestAssistantMessage?: string;
  /** Receives a final transcript. The parent decides what to do with it. */
  onTranscript?: (text: string) => void;
};

export function VoiceControls({ latestAssistantMessage, onTranscript }: VoiceControlsProps) {
  const { language } = useLanguage();
  const profile = useLocalProfile();
  const copy = COPY[language];

  const [readAloud, setReadAloud] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [micAvailable, setMicAvailable] = useState(false);

  const captureRef = useRef<VoiceCapture | null>(null);
  const spokenRef = useRef<string | null>(null);

  const cloudVoiceConsent = profile.data?.consent.cloudVoice === true;

  // Capability detection happens after mount so SSR output stays stable.
  useEffect(() => {
    setTtsAvailable(ttsSupported());
    setMicAvailable(micSupported());
  }, []);

  useEffect(() => onSpeakingChange(setSpeaking), []);

  useEffect(() => {
    return () => {
      captureRef.current?.stop();
      captureRef.current = null;
      stopSpeaking();
    };
  }, []);

  // Speak new assistant messages only while the toggle is on.
  useEffect(() => {
    if (!readAloud || !ttsAvailable) return;
    const message = latestAssistantMessage?.trim();
    if (!message || spokenRef.current === message) return;
    spokenRef.current = message;
    speak(message, language);
  }, [latestAssistantMessage, readAloud, ttsAvailable, language]);

  const grantVoiceConsent = useCallback(() => {
    touch();
    setGranting(true);
    void localProfile
      .update((current) => ({
        ...current,
        consent: { ...current.consent, cloudVoice: true },
      }))
      .catch(() => {
        setVoiceError(copy.micUnsupported);
      })
      .finally(() => setGranting(false));
  }, [copy.micUnsupported]);

  const startListening = useCallback(() => {
    touch();
    setVoiceError(null);
    if (!cloudVoiceConsent) return;

    const capture = new VoiceCapture({ language, interimResults: false });
    captureRef.current = capture;
    capture.onError((message) => {
      setVoiceError(message);
      setListening(false);
    });
    capture.onTranscript((text, isFinal) => {
      if (!isFinal) return;
      onTranscript?.(text);
      capture.stop();
      setListening(false);
    });

    try {
      // Explicit consent token, from a real user gesture. Never automatic.
      capture.start({ cloudVoiceConsent: true });
      setListening(true);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : copy.micUnsupported);
      setListening(false);
    }
  }, [cloudVoiceConsent, language, onTranscript, copy.micUnsupported]);

  const stopListening = useCallback(() => {
    touch();
    captureRef.current?.stop();
    captureRef.current = null;
    setListening(false);
  }, []);

  return (
    <section className="voia-voice" aria-labelledby="voia-voice-heading">
      <h4 id="voia-voice-heading">{copy.heading}</h4>

      <div className="voia-voice-row">
        <button
          type="button"
          className="secondary-button"
          aria-pressed={readAloud}
          disabled={!ttsAvailable}
          onClick={() => {
            touch();
            setReadAloud((current) => {
              const next = !current;
              if (!next) stopSpeaking();
              return next;
            });
          }}
        >
          {readAloud ? copy.stopReading : copy.readAloud}
        </button>

        <button
          type="button"
          className="secondary-button"
          aria-pressed={listening}
          disabled={!cloudVoiceConsent || !micAvailable}
          onClick={() => (listening ? stopListening() : startListening())}
        >
          {listening ? copy.micStop : copy.micStart}
        </button>
      </div>

      {!ttsAvailable ? <p className="voia-voice-note">{copy.ttsUnsupported}</p> : null}
      {!micAvailable ? <p className="voia-voice-note">{copy.micUnsupported}</p> : null}

      {micAvailable && !cloudVoiceConsent ? (
        <div className="voia-voice-consent">
          <p>{copy.consentCopy}</p>
          <button
            type="button"
            className="primary-button"
            onClick={grantVoiceConsent}
            disabled={granting || profile.status !== "unlocked"}
          >
            {granting ? copy.granting : copy.grant}
          </button>
          <p className="voia-voice-note">{copy.micDisabled}</p>
        </div>
      ) : null}

      <p className="voia-status-line" role="status" aria-live="polite">
        {listening ? copy.listening : speaking ? copy.speaking : ""}
      </p>

      {voiceError ? (
        <p className="inline-error" role="alert">
          {voiceError}
        </p>
      ) : null}
    </section>
  );
}

export default VoiceControls;
