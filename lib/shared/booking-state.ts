/**
 * Deterministic booking state machine.
 *
 * This is the authority on which question comes next. The Google AI model may
 * only phrase questions inside the bounds this module supplies — it can never
 * choose an unapproved step, skip consent, or invent a field.
 *
 * Every question has a deterministic local fallback in English and Spanish, so
 * the product works with the AI layer fully unavailable.
 */

import type {
  BookingDraft,
  BookingStep,
  ConsentState,
  Language,
  QuestionId,
} from "./types";

/** Canonical step order for stage 1 and beyond. */
export const STEP_ORDER: readonly BookingStep[] = [
  "language",
  "interpreter",
  "concern",
  "issue_kind",
  "specialty",
  "location",
  "date",
  "time_window",
  "modality",
  "insurance",
  "accessibility",
  "contact",
  "consent",
  "provider_search",
  "hospital_intake",
  "review",
  "submitted",
] as const;

/** Which approved question ids belong to each step. */
export const STEP_QUESTIONS: Record<BookingStep, readonly QuestionId[]> = {
  language: ["preferred_language"],
  interpreter: ["interpreter_needed"],
  concern: ["health_concern"],
  issue_kind: ["issue_kind"],
  specialty: ["specialty_confirm"],
  location: ["preferred_location", "preferred_provider"],
  date: ["preferred_date"],
  time_window: ["preferred_time_window"],
  modality: ["modality"],
  insurance: ["insurance_carrier", "insurance_plan"],
  accessibility: ["accessibility_needs"],
  contact: ["contact_phone", "contact_method", "contact_email"],
  consent: ["consent_care_data", "consent_google_ai", "consent_sms"],
  provider_search: [],
  hospital_intake: [],
  review: [],
  submitted: [],
};

/** Deterministic question text used when AI is off, unavailable, or invalid. */
export const FALLBACK_QUESTIONS: Record<QuestionId, Record<Language, string>> = {
  preferred_language: {
    en: "Which language would you like to continue in — English or Spanish?",
    es: "¿En qué idioma desea continuar: inglés o español?",
  },
  interpreter_needed: {
    en: "Would you like the clinic to arrange an interpreter for your visit?",
    es: "¿Desea que la clínica gestione un intérprete para su visita?",
  },
  health_concern: {
    en: "In a sentence or two, what would you like to be seen for?",
    es: "En una o dos frases, ¿por qué motivo desea la consulta?",
  },
  issue_kind: {
    en: "Is this a new concern, or a follow-up to something you've already been seen for?",
    es: "¿Es un motivo nuevo o un seguimiento de algo ya atendido?",
  },
  specialty_confirm: {
    en: "Which type of care would you like to book? You can confirm or change this.",
    es: "¿Qué tipo de atención desea reservar? Puede confirmarlo o cambiarlo.",
  },
  preferred_location: {
    en: "Which city and state should we search in?",
    es: "¿En qué ciudad y estado debemos buscar?",
  },
  preferred_provider: {
    en: "Do you have a hospital, clinic, or doctor in mind? You can skip this.",
    es: "¿Tiene en mente un hospital, clínica o médico? Puede omitirlo.",
  },
  preferred_date: {
    en: "What date would you prefer?",
    es: "¿Qué fecha prefiere?",
  },
  preferred_time_window: {
    en: "What time of day works best — morning, afternoon, or evening?",
    es: "¿Qué horario le conviene: mañana, tarde o noche?",
  },
  modality: {
    en: "Would you prefer an in-person visit, a telehealth visit, or either?",
    es: "¿Prefiere una visita en persona, por telesalud, o cualquiera?",
  },
  insurance_carrier: {
    en: "Which insurance carrier would you like the clinic to check?",
    es: "¿Qué aseguradora desea que verifique la clínica?",
  },
  insurance_plan: {
    en: "And what is the plan name, if you know it?",
    es: "¿Y cuál es el nombre del plan, si lo sabe?",
  },
  accessibility_needs: {
    en: "Do you need any accessibility accommodations at the visit? You can skip this.",
    es: "¿Necesita adaptaciones de accesibilidad en la visita? Puede omitirlo.",
  },
  contact_phone: {
    en: "What phone number should the clinic use to reach you?",
    es: "¿A qué número de teléfono debe llamarle la clínica?",
  },
  contact_method: {
    en: "How would you prefer to be contacted — phone call, text, or email?",
    es: "¿Cómo prefiere que le contacten: llamada, mensaje o correo?",
  },
  contact_email: {
    en: "Would you like to add an email address? This is optional.",
    es: "¿Desea agregar un correo electrónico? Es opcional.",
  },
  consent_care_data: {
    en: "Voia keeps your details on this device only. May we save your booking information here?",
    es: "Voia guarda sus datos solo en este dispositivo. ¿Podemos guardar aquí su información?",
  },
  consent_google_ai: {
    en: "May we send non-identifying booking messages to Google's AI service to help phrase questions?",
    es: "¿Podemos enviar mensajes de reserva no identificables al servicio de IA de Google para ayudar a redactar preguntas?",
  },
  consent_sms: {
    en: "Would you like a generic text message confirming your request was sent?",
    es: "¿Desea un mensaje de texto genérico confirmando el envío de su solicitud?",
  },
};

function has(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Is a given step satisfied by the current draft/consent? */
export function isStepComplete(
  step: BookingStep,
  draft: BookingDraft,
  consent: ConsentState,
): boolean {
  switch (step) {
    case "language":
      return has(draft.language);
    case "interpreter":
      return draft.interpreterNeeded !== null;
    case "concern":
      return has(draft.healthConcern);
    case "issue_kind":
      return draft.issueKind !== null;
    case "specialty":
      return has(draft.confirmedSpecialty);
    case "location":
      return has(draft.location);
    case "date":
      return has(draft.preferredDate);
    case "time_window":
      return has(draft.preferredTimeWindow);
    case "modality":
      return draft.modality !== null;
    case "insurance":
      return has(draft.insuranceCarrier);
    case "accessibility":
      // Optional free text: considered answered once the patient moves past it.
      return true;
    case "contact":
      return has(draft.phone) && draft.contactMethod !== null;
    case "consent":
      return consent.careData;
    case "provider_search":
    case "hospital_intake":
    case "review":
    case "submitted":
      return false;
    default:
      return false;
  }
}

/** First incomplete step, in canonical order. */
export function computeCurrentStep(draft: BookingDraft, consent: ConsentState): BookingStep {
  for (const step of STEP_ORDER) {
    if (step === "provider_search") return step;
    if (!isStepComplete(step, draft, consent)) return step;
  }
  return "provider_search";
}

/**
 * Steps the assistant is permitted to move to from `current`.
 * Always the current step plus the next two — never a jump past consent.
 */
export function allowedNextSteps(current: BookingStep): BookingStep[] {
  const index = STEP_ORDER.indexOf(current);
  if (index < 0) return [current];
  const window = STEP_ORDER.slice(index, index + 3);

  // Consent is a hard barrier: nothing past it is allowed until it is complete.
  const consentIndex = window.indexOf("consent");
  if (consentIndex > 0) return window.slice(0, consentIndex + 1);
  return [...window];
}

/** Approved question ids the assistant may ask at `current`. */
export function allowedQuestionIds(current: BookingStep): QuestionId[] {
  return [...(STEP_QUESTIONS[current] ?? [])];
}

/** The next unanswered approved question for a step, or null. */
export function nextQuestionId(
  step: BookingStep,
  draft: BookingDraft,
  consent: ConsentState,
): QuestionId | null {
  const ids = allowedQuestionIds(step);
  for (const id of ids) {
    if (!isQuestionAnswered(id, draft, consent)) return id;
  }
  return ids[0] ?? null;
}

export function isQuestionAnswered(
  id: QuestionId,
  draft: BookingDraft,
  consent: ConsentState,
): boolean {
  switch (id) {
    case "preferred_language":
      return has(draft.language);
    case "interpreter_needed":
      return draft.interpreterNeeded !== null;
    case "health_concern":
      return has(draft.healthConcern);
    case "issue_kind":
      return draft.issueKind !== null;
    case "specialty_confirm":
      return has(draft.confirmedSpecialty);
    case "preferred_location":
      return has(draft.location);
    case "preferred_provider":
      return true; // optional
    case "preferred_date":
      return has(draft.preferredDate);
    case "preferred_time_window":
      return has(draft.preferredTimeWindow);
    case "modality":
      return draft.modality !== null;
    case "insurance_carrier":
      return has(draft.insuranceCarrier);
    case "insurance_plan":
      return true; // optional
    case "accessibility_needs":
      return true; // optional
    case "contact_phone":
      return has(draft.phone);
    case "contact_method":
      return draft.contactMethod !== null;
    case "contact_email":
      return true; // optional
    case "consent_care_data":
      return consent.careData;
    case "consent_google_ai":
      return consent.googleAi;
    case "consent_sms":
      return true; // optional
    default:
      return false;
  }
}

/** Deterministic fallback message — used whenever AI output is unusable. */
export function fallbackQuestion(
  step: BookingStep,
  draft: BookingDraft,
  consent: ConsentState,
  language: Language = "en",
): { assistantMessage: string; questionId: QuestionId | null } {
  const id = nextQuestionId(step, draft, consent);
  if (!id) {
    return {
      assistantMessage:
        language === "es"
          ? "Tenemos lo necesario. Busquemos centros públicos que coincidan."
          : "We have what we need. Let's look for public providers that match.",
      questionId: null,
    };
  }
  const text = FALLBACK_QUESTIONS[id];
  return {
    assistantMessage: text[language] ?? text.en,
    questionId: id,
  };
}

/** Progress fraction (0–1) across stage-1 steps, for the progress indicator. */
export function bookingProgress(draft: BookingDraft, consent: ConsentState): number {
  const stage1 = STEP_ORDER.slice(0, STEP_ORDER.indexOf("provider_search"));
  const done = stage1.filter((step) => isStepComplete(step, draft, consent)).length;
  return stage1.length === 0 ? 0 : done / stage1.length;
}

/**
 * Non-identifying state summary safe to send to the hosted model.
 * Deliberately contains NO free text and NO identifiers.
 */
export function modelBookingState(draft: BookingDraft, consent: ConsentState) {
  return {
    hasSelectedProvider: has(draft.providerPreference),
    hasDatePreference: has(draft.preferredDate),
    hasTimeWindow: has(draft.preferredTimeWindow),
    hasInsuranceCarrier: has(draft.insuranceCarrier),
    hasContactMethod: draft.contactMethod !== null,
    interpreterNeeded: draft.interpreterNeeded === true,
    issueKind: draft.issueKind,
    careDataConsent: consent.careData,
    googleAiConsent: consent.googleAi,
  };
}
