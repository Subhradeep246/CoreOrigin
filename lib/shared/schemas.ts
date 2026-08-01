/**
 * Zod schemas for every trust boundary.
 *
 * Two directions matter:
 *  1. Client -> our API. Validated to reject anything unexpected. The assistant
 *     request schema is STRICT so personal information cannot ride along in an
 *     extra key.
 *  2. Google AI -> our API. Every model response is validated before use; an
 *     invalid response triggers the deterministic local fallback.
 */

import { z } from "zod";
import { STEP_ORDER } from "./booking-state";
import type { BookingStep, QuestionId } from "./types";

/** E.164: leading +, country digit 1-9, up to 14 more digits. */
export const E164 = /^\+[1-9]\d{6,14}$/;

export const PhoneSchema = z
  .string()
  .trim()
  .regex(E164, "Enter a phone number in international format, e.g. +12125551234");

export const LanguageSchema = z.enum(["en", "es"]);

export const BookingStepSchema = z.enum(
  STEP_ORDER as unknown as [BookingStep, ...BookingStep[]],
);

export const QuestionIdSchema = z.enum([
  "preferred_language",
  "interpreter_needed",
  "health_concern",
  "issue_kind",
  "specialty_confirm",
  "preferred_location",
  "preferred_provider",
  "preferred_date",
  "preferred_time_window",
  "modality",
  "insurance_carrier",
  "insurance_plan",
  "accessibility_needs",
  "contact_phone",
  "contact_method",
  "contact_email",
  "consent_care_data",
  "consent_google_ai",
  "consent_sms",
] as unknown as [QuestionId, ...QuestionId[]]);

export const BookingStatusSchema = z.enum(["confirmed", "pending_provider", "unavailable"]);

/* ------------------------------------------------------------------ */
/* OTP                                                                 */
/* ------------------------------------------------------------------ */

export const RequestOtpSchema = z.strictObject({
  phone: PhoneSchema,
});

export const VerifyOtpSchema = z.strictObject({
  phone: PhoneSchema,
  code: z.string().trim().regex(/^\d{4,10}$/, "Enter the numeric code from your text message."),
});

/* ------------------------------------------------------------------ */
/* Assistant: client -> our server                                     */
/* ------------------------------------------------------------------ */

/**
 * The ONLY shape allowed to reach the assistant route.
 *
 * STRICT on purpose: unknown keys are rejected, so a client bug cannot leak
 * a name, phone, email, DOB, insurance id, or free-text concern to Google.
 * Note the absence of any free-text field.
 */
export const AssistantRespondSchema = z.strictObject({
  language: LanguageSchema,
  currentStep: BookingStepSchema,
  allowedNextSteps: z.array(BookingStepSchema).min(1).max(6),
  allowedQuestionIds: z.array(QuestionIdSchema).max(6),
  /** Broad category only, patient-confirmed. Never a diagnosis. */
  confirmedSpecialty: z.string().trim().max(60).nullable(),
  bookingState: z.strictObject({
    hasSelectedProvider: z.boolean(),
    hasDatePreference: z.boolean(),
    hasTimeWindow: z.boolean(),
    hasInsuranceCarrier: z.boolean(),
    hasContactMethod: z.boolean(),
    interpreterNeeded: z.boolean(),
    issueKind: z.enum(["new", "follow_up"]).nullable(),
    careDataConsent: z.boolean(),
    googleAiConsent: z.boolean(),
  }),
});

export type AssistantRespondInput = z.infer<typeof AssistantRespondSchema>;

/* ------------------------------------------------------------------ */
/* Assistant: Google AI -> our server                                  */
/* ------------------------------------------------------------------ */

/**
 * Expected structured model output. Unknown keys are stripped rather than
 * rejected, so harmless model verbosity does not force a fallback — but every
 * field we actually use is type-checked.
 */
export const AssistantModelResponseSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(600),
  nextStep: BookingStepSchema,
  suggestedSpecialty: z.string().trim().max(60).nullable().optional().default(null),
  requiresPatientConfirmation: z.boolean().optional().default(false),
  /** Present only when the model detects emergency language. */
  action: z.enum(["ask", "emergency_escalation"]).optional().default("ask"),
});

export type AssistantModelResponse = z.infer<typeof AssistantModelResponseSchema>;

/** What our route returns to the browser. */
export const AssistantReplySchema = z.object({
  assistantMessage: z.string(),
  nextStep: BookingStepSchema,
  questionId: QuestionIdSchema.nullable(),
  suggestedSpecialty: z.string().nullable(),
  requiresPatientConfirmation: z.boolean(),
  /** True when the deterministic local fallback produced this reply. */
  fallback: z.boolean(),
  source: z.enum(["model", "fallback", "emergency"]),
});

export type AssistantReply = z.infer<typeof AssistantReplySchema>;

/* ------------------------------------------------------------------ */
/* Provider search (Tavily)                                            */
/* ------------------------------------------------------------------ */

/**
 * STRICT. Tavily may receive only specialty, coarse location, and a
 * non-sensitive provider preference. Nothing else is accepted.
 */
export const ProviderSearchSchema = z.strictObject({
  specialty: z.string().trim().min(2).max(60),
  /** Coarse area only, e.g. "Boston, MA". */
  location: z.string().trim().min(2).max(80),
  providerPreference: z.string().trim().max(80).optional().default(""),
  language: LanguageSchema.optional().default("en"),
});

export type ProviderSearchInput = z.infer<typeof ProviderSearchSchema>;

export const ProviderResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  sourceUrl: z.string(),
  sourceLabel: z.string(),
});

/* ------------------------------------------------------------------ */
/* Booking submission                                                  */
/* ------------------------------------------------------------------ */

export const IntakeAnswersSchema = z.record(z.string(), z.string().max(300));

export const BookingPacketSchema = z.object({
  hospitalId: z.string().trim().min(1).max(80),
  hospitalName: z.string().trim().min(1).max(200),
  language: LanguageSchema,
  interpreterNeeded: z.boolean(),
  reasonForVisit: z.string().trim().max(1000),
  issueKind: z.enum(["new", "follow_up"]),
  specialty: z.string().trim().max(60),
  modality: z.enum(["in_person", "telehealth", "either"]),
  preferredDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTimeWindow: z.string().trim().max(40),
  timezone: z.string().trim().max(60),
  insuranceCarrier: z.string().trim().max(80),
  insurancePlan: z.string().trim().max(80),
  accessibilityNeeds: z.string().trim().max(300),
  phone: PhoneSchema,
  contactMethod: z.enum(["phone", "sms", "email"]),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  intake: IntakeAnswersSchema,
});

export const SubmitBookingSchema = z.strictObject({
  packet: BookingPacketSchema,
  /** Must be literally true: the patient checked the authorization box. */
  hospitalSharingConsent: z.literal(true, {
    message: "Explicit authorization is required before contacting the hospital.",
  }),
});

export type SubmitBookingInput = z.infer<typeof SubmitBookingSchema>;

export const BookingResultSchema = z.object({
  status: BookingStatusSchema,
  reference: z.string().optional(),
  message: z.string(),
  simulated: z.boolean(),
  submittedAt: z.string(),
});

/* ------------------------------------------------------------------ */
/* SMS receipt                                                         */
/* ------------------------------------------------------------------ */

/**
 * STRICT and deliberately minimal: a phone number and a consent flag.
 * The message body is generated server-side from a fixed template so no
 * health detail can be injected by the client.
 */
export const SmsReceiptSchema = z.strictObject({
  phone: PhoneSchema,
  smsConsent: z.literal(true, {
    message: "SMS consent is required before sending a text message.",
  }),
  language: LanguageSchema.optional().default("en"),
});

export type SmsReceiptInput = z.infer<typeof SmsReceiptSchema>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Flatten Zod issues into short, user-safe messages (never echoes values). */
export function issueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.message);
}
