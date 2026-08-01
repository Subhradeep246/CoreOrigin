/**
 * POST /api/assistant/respond — phrase the next approved booking question.
 *
 * Stateless relay. No database, no server session, no cookie, no patient record.
 * Nothing is written anywhere and nothing is logged: not the request, not the
 * model prompt, not the model response.
 *
 * The request body is validated by the STRICT `AssistantRespondSchema`, which is
 * the PII guard: unknown keys are rejected, so a client bug cannot smuggle a
 * name, phone, email, DOB, insurance id, or free-text concern to Google.
 *
 * NOTE ON THE EMERGENCY GATE: this route receives NO free text, so it cannot run
 * the deterministic emergency text gate itself. The client runs `checkEmergency`
 * on the patient's concern before ever calling this route. The only emergency
 * path here is the model's own `action === "emergency_escalation"` signal.
 */

import { emergencyGuidance } from "@/lib/shared/safety";
import { AssistantRespondSchema, type AssistantRespondInput } from "@/lib/shared/schemas";
import {
  allowedNextSteps,
  fallbackQuestion,
  nextQuestionId,
  STEP_ORDER,
} from "@/lib/shared/booking-state";
import type {
  BookingDraft,
  BookingStep,
  ConsentState,
  QuestionId,
} from "@/lib/shared/types";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import { googleAiConfigError, requestBookingTurn } from "@/lib/server/google-ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 30 turns per minute per opaque client key. */
const LIMIT = 30;
const WINDOW_MS = 60 * 1000;

/**
 * Non-identifying marker used to satisfy the local state machine's "is this
 * answered?" checks. It is never a patient value and never leaves this process.
 */
const ANSWERED = "answered";

type ReplyBody = {
  assistantMessage: string;
  nextStep: BookingStep;
  questionId: QuestionId | null;
  suggestedSpecialty: string | null;
  requiresPatientConfirmation: boolean;
  fallback: boolean;
  source: "model" | "fallback" | "emergency";
  configError?: string;
  note?: string;
};

/**
 * Rebuild just enough local state for the deterministic state machine.
 *
 * Only booleans, enums, and the patient-confirmed broad specialty are available
 * here, so completed free-text steps are represented by a placeholder token.
 */
function deriveLocalState(input: AssistantRespondInput): {
  draft: BookingDraft;
  consent: ConsentState;
} {
  const state = input.bookingState;
  const currentIndex = STEP_ORDER.indexOf(input.currentStep);
  const isPast = (step: BookingStep): boolean => {
    const index = STEP_ORDER.indexOf(step);
    return index >= 0 && currentIndex >= 0 && index < currentIndex;
  };

  const draft: BookingDraft = {
    language: input.language,
    interpreterNeeded: isPast("interpreter") ? state.interpreterNeeded : null,
    healthConcern: isPast("concern") ? ANSWERED : "",
    issueKind: state.issueKind,
    confirmedSpecialty: input.confirmedSpecialty ?? "",
    location: isPast("location") ? ANSWERED : "",
    providerPreference: state.hasSelectedProvider ? ANSWERED : "",
    preferredDate: state.hasDatePreference ? ANSWERED : "",
    preferredTimeWindow: state.hasTimeWindow ? ANSWERED : "",
    modality: isPast("modality") ? "either" : null,
    insuranceCarrier: state.hasInsuranceCarrier ? ANSWERED : "",
    insurancePlan: "",
    accessibilityNeeds: "",
    phone: state.hasContactMethod || isPast("contact") ? ANSWERED : "",
    contactMethod: state.hasContactMethod ? "phone" : null,
    email: "",
  };

  const consent: ConsentState = {
    careData: state.careDataConsent,
    googleAi: state.googleAiConsent,
    smsReceipt: false,
    cloudVoice: false,
  };

  return { draft, consent };
}

/** Deterministic local reply. Works with the AI layer fully unavailable. */
function localFallback(input: AssistantRespondInput, extra: Partial<ReplyBody> = {}): ReplyBody {
  const { draft, consent } = deriveLocalState(input);
  const { assistantMessage, questionId } = fallbackQuestion(
    input.currentStep,
    draft,
    consent,
    input.language,
  );

  return {
    assistantMessage,
    nextStep: input.currentStep,
    questionId,
    suggestedSpecialty: null,
    requiresPatientConfirmation: false,
    fallback: true,
    source: "fallback",
    ...extra,
  };
}

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "assistant"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many requests. Please wait a moment and try again.");
  }

  // a. Validate. Strict schema: unknown keys are rejected outright.
  const parsed = await readJson(request, AssistantRespondSchema);
  if (!parsed.ok) return parsed.response;
  const data = parsed.data;

  // b. Consent gate. Without explicit Google AI consent nothing is sent upstream.
  if (data.bookingState.googleAiConsent !== true) {
    return jsonNoStore(
      localFallback(data, {
        note:
          data.language === "es"
            ? "Se requiere su consentimiento explícito antes de usar el servicio de IA de Google. Voia está usando sus preguntas integradas."
            : "Your explicit consent is required before the hosted Google AI service can be used. Voia is using its built-in questions instead.",
      }),
    );
  }

  // c. Config gate. Includes GOOGLE_AI_MODE !== "paid", which is a hard block.
  const configError = googleAiConfigError();
  if (configError !== null) {
    return jsonNoStore(localFallback(data, { configError }));
  }

  // d. Hosted turn. `null` covers transport errors, timeouts, malformed output,
  //    and any out-of-bounds step. Silent by design.
  const model = await requestBookingTurn(data);
  if (model === null) {
    return jsonNoStore(localFallback(data));
  }

  // e. Emergency escalation short-circuits the booking flow entirely.
  if (model.action === "emergency_escalation") {
    return jsonNoStore({
      assistantMessage: emergencyGuidance("medical", data.language),
      nextStep: data.currentStep,
      questionId: null,
      suggestedSpecialty: null,
      requiresPatientConfirmation: false,
      fallback: false,
      source: "emergency",
    } satisfies ReplyBody);
  }

  // Defence in depth: re-derive the permitted steps server-side rather than
  // trusting the allow-list the client supplied.
  if (!allowedNextSteps(data.currentStep).includes(model.nextStep)) {
    return jsonNoStore(localFallback(data));
  }

  // f. Success. The question id is always computed locally, never by the model.
  const { draft, consent } = deriveLocalState(data);
  return jsonNoStore({
    assistantMessage: model.assistantMessage,
    nextStep: model.nextStep,
    questionId: nextQuestionId(model.nextStep, draft, consent),
    suggestedSpecialty: model.suggestedSpecialty ?? null,
    requiresPatientConfirmation: model.requiresPatientConfirmation === true,
    fallback: false,
    source: "model",
  } satisfies ReplyBody);
}
