/**
 * Deterministic emergency gate.
 *
 * This module is pure pattern matching. It runs BEFORE any Google AI call,
 * BEFORE any Tavily search, and BEFORE any booking submission.
 *
 * This is safety messaging only. It is NOT diagnosis, triage, screening,
 * or voice-anomaly detection. It never infers disease. A negative result
 * means "no emergency phrase matched" — nothing more.
 */

import type { Language } from "./types";

export type EmergencyCategory = "medical" | "self_harm";

export type EmergencyCheck =
  | { emergency: false }
  | { emergency: true; category: EmergencyCategory; guidance: string };

/**
 * Acute medical phrases. Deliberately narrow and high-signal to limit false
 * positives; this gate must not swallow ordinary booking language.
 */
const MEDICAL_PATTERNS: readonly RegExp[] = [
  // Stroke signs
  /\bface\s+(is\s+)?droop/i,
  /\bfacial\s+droop/i,
  /\bdrooping\s+face/i,
  /\bslurred\s+speech/i,
  /\bslurring\s+(my\s+)?word/i,
  /\bcan'?t\s+speak\s+clearly/i,
  /\bone[-\s]?sided\s+weak/i,
  /\bweak(ness)?\s+on\s+one\s+side/i,
  /\bnumb\s+on\s+one\s+side/i,
  /\bcan'?t\s+move\s+(my\s+)?(one\s+)?(arm|leg|side)/i,
  // Cardiac
  /\bsevere\s+chest\s+(pain|pressure|tightness)/i,
  /\bcrushing\s+chest/i,
  /\bchest\s+(pain|pressure)\s+(and|with)\s+(sweat|nausea|arm)/i,
  // Respiratory
  /\bsevere\s+(trouble|difficulty)\s+breathing/i,
  /\bcan'?t\s+breathe/i,
  /\bcannot\s+breathe/i,
  /\bstruggling\s+to\s+breathe/i,
  /\bgasping\b/i,
  /\bturning\s+blue\b/i,
  // Neuro / consciousness
  /\bseizure\b/i,
  /\bconvulsion/i,
  /\bunconscious\b/i,
  /\bpassed\s+out\b/i,
  /\bloss\s+of\s+consciousness\b/i,
  /\bunresponsive\b/i,
  // Spanish
  /\bdolor\s+(fuerte|intenso|severo)\s+(en\s+)?el\s+pecho/i,
  /\bno\s+puedo\s+respirar/i,
  /\bdificultad\s+(grave|severa)\s+para\s+respirar/i,
  /\bconvulsi[oó]n/i,
  /\bdesmay[oó]/i,
  /\bp[eé]rdida\s+de\s+conciencia/i,
  /\bcara\s+ca[ií]da/i,
  /\bhabla\s+arrastrada/i,
  /\bdebilidad\s+en\s+un\s+lado/i,
] as const;

/** Active self-harm / suicide intent. */
const SELF_HARM_PATTERNS: readonly RegExp[] = [
  /\bkill\s+my\s?self\b/i,
  /\bkilling\s+my\s?self\b/i,
  /\bend\s+my\s+life\b/i,
  /\btake\s+my\s+own\s+life\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bsuicid/i,
  /\bhurt\s+my\s?self\b/i,
  /\bharm\s+my\s?self\b/i,
  /\bcut\s+my\s?self\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
  // Spanish
  /\bsuicid/i,
  /\bmatarme\b/i,
  /\bquitarme\s+la\s+vida\b/i,
  /\bquiero\s+morir(me)?\b/i,
  /\blastimarme\b/i,
  /\bda[ñn]arme\b/i,
] as const;

const GUIDANCE: Record<EmergencyCategory, Record<Language, string>> = {
  medical: {
    en:
      "What you described may be a medical emergency. Please call your local emergency number (911 in the US and Canada) right now, or go to the nearest emergency department. Do not wait for an appointment. Voia cannot help with emergencies.",
    es:
      "Lo que describe podría ser una emergencia médica. Llame ahora mismo a su número local de emergencias (911 en EE. UU. y Canadá) o vaya al servicio de urgencias más cercano. No espere una cita. Voia no puede ayudar en emergencias.",
  },
  self_harm: {
    en:
      "It sounds like you may be in crisis, and you deserve immediate support. In the US and Canada you can call or text 988 to reach the Suicide and Crisis Lifeline, available 24/7. If you are in immediate danger, call 911 or go to the nearest emergency department. Voia cannot provide crisis care.",
    es:
      "Parece que podría estar en crisis y merece apoyo inmediato. En EE. UU. y Canadá puede llamar o enviar un mensaje al 988 para comunicarse con la Línea de Prevención del Suicidio y Crisis, disponible 24/7. Si corre peligro inmediato, llame al 911 o acuda al servicio de urgencias más cercano. Voia no puede brindar atención de crisis.",
  },
};

/**
 * Check arbitrary patient text for emergency language.
 *
 * Self-harm takes precedence over medical because the guidance is more specific.
 */
export function checkEmergency(text: string, language: Language = "en"): EmergencyCheck {
  if (typeof text !== "string" || !text.trim()) return { emergency: false };
  const value = text.normalize("NFKC");

  if (SELF_HARM_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      emergency: true,
      category: "self_harm",
      guidance: GUIDANCE.self_harm[language] ?? GUIDANCE.self_harm.en,
    };
  }

  if (MEDICAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      emergency: true,
      category: "medical",
      guidance: GUIDANCE.medical[language] ?? GUIDANCE.medical.en,
    };
  }

  return { emergency: false };
}

/** Convenience for scanning several fields at once (e.g. concern + free text). */
export function checkEmergencyAcross(
  values: Array<string | null | undefined>,
  language: Language = "en",
): EmergencyCheck {
  for (const value of values) {
    if (!value) continue;
    const result = checkEmergency(value, language);
    if (result.emergency) return result;
  }
  return { emergency: false };
}

export function emergencyGuidance(
  category: EmergencyCategory,
  language: Language = "en",
): string {
  return GUIDANCE[category][language] ?? GUIDANCE[category].en;
}
