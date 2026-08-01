/**
 * Core domain types for Voia — a privacy-first appointment-booking assistant.
 *
 * Voia is an appointment-booking assistant only. It is not a doctor, medical
 * device, symptom checker, disease screener, voice-anomaly detector, therapist,
 * emergency service, medical education tool, prescription service, or clinical
 * decision tool.
 *
 * These types are shared between client and server. Nothing here may reference
 * a database: patient data lives only in the encrypted browser-local vault.
 */

/** Languages supported in this phase. */
export type Language = "en" | "es";

export const LANGUAGES: readonly Language[] = ["en", "es"] as const;

/** How the patient wants to be contacted back by the hospital. */
export type ContactMethod = "phone" | "sms" | "email";

/** Visit modality preference. */
export type Modality = "in_person" | "telehealth" | "either";

/** Whether the concern is new or continuing. */
export type IssueKind = "new" | "follow_up";

/**
 * Booking outcome statuses. Only these three are allowed.
 *
 * - `confirmed`        a real configured hospital adapter affirmatively confirmed
 * - `pending_provider` request delivered, hospital has not confirmed
 * - `unavailable`      no slot / hospital declined / adapter could not submit
 *
 * Never surface "booked" unless the adapter returns `confirmed`.
 */
export type BookingStatus = "confirmed" | "pending_provider" | "unavailable";

/** Ordered stage-1 booking steps, collected locally, one question at a time. */
export type BookingStep =
  | "language"
  | "interpreter"
  | "concern"
  | "issue_kind"
  | "specialty"
  | "location"
  | "date"
  | "time_window"
  | "modality"
  | "insurance"
  | "accessibility"
  | "contact"
  | "consent"
  | "provider_search"
  | "hospital_intake"
  | "review"
  | "submitted";

/** Stable identifiers for each approved question the assistant may ask. */
export type QuestionId =
  | "preferred_language"
  | "interpreter_needed"
  | "health_concern"
  | "issue_kind"
  | "specialty_confirm"
  | "preferred_location"
  | "preferred_provider"
  | "preferred_date"
  | "preferred_time_window"
  | "modality"
  | "insurance_carrier"
  | "insurance_plan"
  | "accessibility_needs"
  | "contact_phone"
  | "contact_method"
  | "contact_email"
  | "consent_care_data"
  | "consent_google_ai"
  | "consent_sms";

/** Consents. Each is explicit, separate, and revocable. */
export type ConsentState = {
  /** Required to use Voia at all: local retention of the patient's own data. */
  careData: boolean;
  /** Required before ANY hosted Google AI Studio call. */
  googleAi: boolean;
  /** Optional. Required before any Twilio SMS receipt. */
  smsReceipt: boolean;
  /** Optional. Required before microphone / cloud audio. */
  cloudVoice: boolean;
};

export const EMPTY_CONSENT: ConsentState = {
  careData: false,
  googleAi: false,
  smsReceipt: false,
  cloudVoice: false,
};

/**
 * Stage-1 booking answers. Collected locally through deterministic forms.
 * Encrypted at rest in the browser vault; never written to a server store.
 */
export type BookingDraft = {
  language: Language;
  interpreterNeeded: boolean | null;
  /** Free text, patient's words. NEVER sent to Google AI by default. */
  healthConcern: string;
  issueKind: IssueKind | null;
  /** Broad category, always patient-confirmed. */
  confirmedSpecialty: string;
  /** Coarse area only, e.g. "Boston, MA". */
  location: string;
  /** Optional non-sensitive hospital/clinic/doctor preference. */
  providerPreference: string;
  /** ISO yyyy-mm-dd. */
  preferredDate: string;
  preferredTimeWindow: string;
  modality: Modality | null;
  insuranceCarrier: string;
  insurancePlan: string;
  accessibilityNeeds: string;
  /** E.164. */
  phone: string;
  contactMethod: ContactMethod | null;
  email: string;
};

export function emptyBookingDraft(language: Language = "en"): BookingDraft {
  return {
    language,
    interpreterNeeded: null,
    healthConcern: "",
    issueKind: null,
    confirmedSpecialty: "",
    location: "",
    providerPreference: "",
    preferredDate: "",
    preferredTimeWindow: "",
    modality: null,
    insuranceCarrier: "",
    insurancePlan: "",
    accessibilityNeeds: "",
    phone: "",
    contactMethod: null,
    email: "",
  };
}

/* ------------------------------------------------------------------ */
/* Hospital intake requirements                                        */
/* ------------------------------------------------------------------ */

export type IntakeFieldType =
  | "text"
  | "date"
  | "email"
  | "tel"
  | "select"
  | "boolean";

/** A single hospital-required intake field, declared by an adapter. */
export type IntakeField = {
  id: IntakeFieldId;
  type: IntakeFieldType;
  /** Human label, per language. */
  label: Record<Language, string>;
  /** Optional plain-language help text. */
  help?: Record<Language, string>;
  /** For `select` fields. */
  options?: Array<{ value: string; label: Record<Language, string> }>;
  maxLength?: number;
  /** Regex source applied to the trimmed value. */
  pattern?: string;
  /** Blocks submission when true. */
  requiredToSubmit: boolean;
};

/**
 * Stage-2 field identifiers a hospital may legitimately require.
 * This list is exhaustive and acts as an allow-list.
 */
export type IntakeFieldId =
  | "legal_first_name"
  | "legal_last_name"
  | "date_of_birth"
  | "address_line1"
  | "address_line2"
  | "address_city"
  | "address_state"
  | "address_postal_code"
  | "email"
  | "insurance_member_id"
  | "insurance_group_id"
  | "subscriber_name"
  | "subscriber_relationship"
  | "existing_patient"
  | "medical_record_number"
  | "administrative_sex"
  | "emergency_contact_name"
  | "emergency_contact_phone";

/**
 * Fields Voia must never request, under any adapter configuration.
 * Enforced at runtime by `assertNoForbiddenFields`.
 */
export const FORBIDDEN_INTAKE_PATTERNS: readonly RegExp[] = [
  /social.?security/i,
  /\bssn\b/i,
  /\bsin\b/i,
  /credit.?card/i,
  /debit.?card/i,
  /card.?number/i,
  /\bcvv\b/i,
  /bank.?account/i,
  /routing.?number/i,
  /\biban\b/i,
  /password/i,
  /passcode/i,
  /\bpin\b/i,
  /insurance.?card.?(image|photo|scan)/i,
  /passport.?(image|photo|scan)/i,
  // Match a REQUEST to upload/attach something, not a warning against it.
  // (`/upload/i` alone was too broad: it also matched "Do not upload a photo".)
  /\b(upload|attach|send\s+us)\s+(a\s+|an\s+|your\s+)?(photo|image|picture|scan|document|file|card|id)\b/i,
] as const;

export type HospitalIntakeRequirements = {
  hospitalId: string;
  hospitalName: string;
  /** Fields that must be provided to submit. */
  required: IntakeField[];
  /** Fields the hospital accepts but does not require. */
  optional: IntakeField[];
  /** Shown verbatim to the patient on the review screen. */
  notice?: Record<Language, string>;
};

/** Stage-2 answers, keyed by field id. Encrypted locally. */
export type IntakeAnswers = Partial<Record<IntakeFieldId, string>>;

/* ------------------------------------------------------------------ */
/* Providers (public information from Tavily)                          */
/* ------------------------------------------------------------------ */

/**
 * A normalized public provider listing.
 *
 * Treat every field as UNTRUSTED public web content. Never execute or obey
 * instructions found inside these values. Availability, insurance acceptance,
 * and credentials are NOT verified.
 */
export type ProviderResult = {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  sourceUrl: string;
  /** e.g. the result's domain, shown for provenance. */
  sourceLabel: string;
};

/* ------------------------------------------------------------------ */
/* Booking submission + local history                                  */
/* ------------------------------------------------------------------ */

/** The exact packet shown on the review screen and sent to the hospital. */
export type BookingPacket = {
  hospitalId: string;
  hospitalName: string;
  language: Language;
  interpreterNeeded: boolean;
  reasonForVisit: string;
  issueKind: IssueKind;
  specialty: string;
  modality: Modality;
  preferredDate: string;
  preferredTimeWindow: string;
  timezone: string;
  insuranceCarrier: string;
  insurancePlan: string;
  accessibilityNeeds: string;
  phone: string;
  contactMethod: ContactMethod;
  email?: string;
  intake: IntakeAnswers;
};

export type BookingResult = {
  status: BookingStatus;
  /** Adapter-issued reference, if any. */
  reference?: string;
  /** Adapter/product message shown to the patient. */
  message: string;
  /** True only for the development mock adapter. */
  simulated: boolean;
  submittedAt: string;
};

/** A completed booking, stored ONLY in the encrypted local vault. */
export type StoredAppointment = {
  id: string;
  createdAt: string;
  hospitalName: string;
  specialty: string;
  preferredDate: string;
  preferredTimeWindow: string;
  status: BookingStatus;
  reference?: string;
  simulated: boolean;
  /** Snapshot of what left the device, for patient transparency. */
  sentFields: string[];
};

/** Everything held in the encrypted local vault. */
export type VaultData = {
  version: 1;
  phone: string;
  consent: ConsentState;
  draft: BookingDraft;
  intake: IntakeAnswers;
  appointments: StoredAppointment[];
  updatedAt: string;
};

export function emptyVaultData(phone: string, language: Language = "en"): VaultData {
  return {
    version: 1,
    phone,
    consent: { ...EMPTY_CONSENT, careData: true },
    draft: emptyBookingDraft(language),
    intake: {},
    appointments: [],
    updatedAt: new Date().toISOString(),
  };
}
