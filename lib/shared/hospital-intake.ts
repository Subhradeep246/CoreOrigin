/**
 * Stage-2 hospital intake field catalog, validation, and the forbidden-field guard.
 *
 * Adapters declare WHICH fields they need by id. They may not invent fields.
 * Every field must come from `INTAKE_FIELD_CATALOG`, which acts as an allow-list.
 */

import {
  FORBIDDEN_INTAKE_PATTERNS,
  type HospitalIntakeRequirements,
  type IntakeAnswers,
  type IntakeField,
  type IntakeFieldId,
  type Language,
} from "./types";

/**
 * The complete set of intake fields Voia is willing to collect.
 * Anything not here cannot be requested by any adapter.
 */
export const INTAKE_FIELD_CATALOG: Record<IntakeFieldId, Omit<IntakeField, "requiredToSubmit">> = {
  legal_first_name: {
    id: "legal_first_name",
    type: "text",
    maxLength: 80,
    label: { en: "Legal first name", es: "Nombre legal" },
    help: {
      en: "As it appears on your insurance or ID.",
      es: "Como aparece en su seguro o identificación.",
    },
  },
  legal_last_name: {
    id: "legal_last_name",
    type: "text",
    maxLength: 80,
    label: { en: "Legal last name", es: "Apellido legal" },
  },
  date_of_birth: {
    id: "date_of_birth",
    type: "date",
    label: { en: "Date of birth", es: "Fecha de nacimiento" },
    help: {
      en: "Hospitals use this to match you to an existing record.",
      es: "Los hospitales lo usan para localizar su expediente.",
    },
  },
  address_line1: {
    id: "address_line1",
    type: "text",
    maxLength: 120,
    label: { en: "Street address", es: "Dirección" },
  },
  address_line2: {
    id: "address_line2",
    type: "text",
    maxLength: 120,
    label: { en: "Apartment, suite (optional)", es: "Apartamento, suite (opcional)" },
  },
  address_city: {
    id: "address_city",
    type: "text",
    maxLength: 80,
    label: { en: "City", es: "Ciudad" },
  },
  address_state: {
    id: "address_state",
    type: "text",
    maxLength: 40,
    label: { en: "State or province", es: "Estado o provincia" },
  },
  address_postal_code: {
    id: "address_postal_code",
    type: "text",
    maxLength: 12,
    label: { en: "Postal code", es: "Código postal" },
  },
  email: {
    id: "email",
    type: "email",
    maxLength: 200,
    label: { en: "Email", es: "Correo electrónico" },
  },
  insurance_member_id: {
    id: "insurance_member_id",
    type: "text",
    maxLength: 60,
    label: { en: "Insurance member ID", es: "ID de miembro del seguro" },
    help: {
      en: "Type the member number printed on your insurance card. Never send a picture of the card.",
      es: "Escriba el número de miembro impreso en su tarjeta. Nunca envíe una foto de la tarjeta.",
    },
  },
  insurance_group_id: {
    id: "insurance_group_id",
    type: "text",
    maxLength: 60,
    label: { en: "Insurance group ID", es: "ID de grupo del seguro" },
  },
  subscriber_name: {
    id: "subscriber_name",
    type: "text",
    maxLength: 160,
    label: { en: "Policy subscriber name", es: "Nombre del titular de la póliza" },
    help: {
      en: "Only needed if the plan is under someone else's name.",
      es: "Solo si la póliza está a nombre de otra persona.",
    },
  },
  subscriber_relationship: {
    id: "subscriber_relationship",
    type: "select",
    label: { en: "Your relationship to the subscriber", es: "Su relación con el titular" },
    options: [
      { value: "self", label: { en: "Self", es: "Yo mismo" } },
      { value: "spouse", label: { en: "Spouse or partner", es: "Cónyuge o pareja" } },
      { value: "child", label: { en: "Child", es: "Hijo/a" } },
      { value: "other", label: { en: "Other", es: "Otro" } },
    ],
  },
  existing_patient: {
    id: "existing_patient",
    type: "boolean",
    label: { en: "Have you been seen here before?", es: "¿Ha sido atendido aquí antes?" },
  },
  medical_record_number: {
    id: "medical_record_number",
    type: "text",
    maxLength: 60,
    label: { en: "Medical record number (if known)", es: "Número de expediente (si lo sabe)" },
  },
  administrative_sex: {
    id: "administrative_sex",
    type: "select",
    label: {
      en: "Administrative sex on file",
      es: "Sexo administrativo en el expediente",
    },
    help: {
      en: "Some hospitals are legally required to record this for billing and record matching.",
      es: "Algunos hospitales deben registrarlo por ley para facturación y coincidencia de expedientes.",
    },
    options: [
      { value: "female", label: { en: "Female", es: "Femenino" } },
      { value: "male", label: { en: "Male", es: "Masculino" } },
      { value: "unspecified", label: { en: "Prefer not to say", es: "Prefiero no decirlo" } },
    ],
  },
  emergency_contact_name: {
    id: "emergency_contact_name",
    type: "text",
    maxLength: 160,
    label: { en: "Emergency contact name", es: "Nombre del contacto de emergencia" },
  },
  emergency_contact_phone: {
    id: "emergency_contact_phone",
    type: "tel",
    maxLength: 20,
    label: { en: "Emergency contact phone", es: "Teléfono del contacto de emergencia" },
  },
};

/** Build a concrete field from the catalog. */
export function intakeField(id: IntakeFieldId, requiredToSubmit: boolean): IntakeField {
  const base = INTAKE_FIELD_CATALOG[id];
  if (!base) throw new Error(`Unknown intake field id: ${id}`);
  return { ...base, requiredToSubmit };
}

/**
 * Patterns that are meaningful on a field *id* but produce false positives in
 * human guidance text. "Do not send a photo" is protective advice, not a request
 * for an upload; "PIN" appears in unlock instructions. These are still enforced
 * against ids, where a genuine violation would surface.
 */
const PROSE_EXEMPT_PATTERNS: readonly RegExp[] = [/upload/i, /\bpin\b/i] as const;

function isProseExempt(pattern: RegExp): boolean {
  return PROSE_EXEMPT_PATTERNS.some((exempt) => exempt.source === pattern.source);
}

/**
 * Guard: reject any adapter that tries to request a forbidden field.
 *
 * Field ids are checked against every forbidden pattern. Labels and help text
 * are checked against all but `PROSE_EXEMPT_PATTERNS`, so protective wording
 * ("never send a picture of the card") does not trip the guard while a field
 * genuinely named `insurance_card_upload` still does.
 *
 * Throws — this is a programming/configuration error, not user input.
 */
export function assertNoForbiddenFields(requirements: HospitalIntakeRequirements): void {
  const all = [...requirements.required, ...requirements.optional];
  for (const field of all) {
    if (!(field.id in INTAKE_FIELD_CATALOG)) {
      throw new Error(
        `Hospital "${requirements.hospitalId}" requested field "${field.id}" which is not in the approved intake catalog.`,
      );
    }

    const prose = [field.label.en, field.label.es, field.help?.en, field.help?.es]
      .filter(Boolean)
      .join(" ");

    for (const pattern of FORBIDDEN_INTAKE_PATTERNS) {
      const matchesId = pattern.test(field.id);
      const matchesProse = !isProseExempt(pattern) && pattern.test(prose);
      if (matchesId || matchesProse) {
        throw new Error(
          `Hospital "${requirements.hospitalId}" requested a forbidden field matching ${pattern}. Voia never collects SSNs, payment details, passwords, or document uploads.`,
        );
      }
    }
  }
}

export type IntakeValidationError = {
  fieldId: IntakeFieldId;
  message: Record<Language, string>;
};

/** Validate stage-2 answers against a hospital's declared requirements. */
export function validateIntakeAnswers(
  requirements: HospitalIntakeRequirements,
  answers: IntakeAnswers,
): IntakeValidationError[] {
  const errors: IntakeValidationError[] = [];
  const all = [...requirements.required, ...requirements.optional];

  for (const field of all) {
    const raw = answers[field.id];
    const value = typeof raw === "string" ? raw.trim() : "";

    if (!value) {
      if (field.requiredToSubmit) {
        errors.push({
          fieldId: field.id,
          message: {
            en: `${field.label.en} is required by ${requirements.hospitalName}.`,
            es: `${field.label.es} es obligatorio para ${requirements.hospitalName}.`,
          },
        });
      }
      continue;
    }

    if (field.maxLength && value.length > field.maxLength) {
      errors.push({
        fieldId: field.id,
        message: {
          en: `${field.label.en} must be ${field.maxLength} characters or fewer.`,
          es: `${field.label.es} debe tener ${field.maxLength} caracteres o menos.`,
        },
      });
      continue;
    }

    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      errors.push({
        fieldId: field.id,
        message: {
          en: "Enter a valid email address.",
          es: "Ingrese un correo electrónico válido.",
        },
      });
      continue;
    }

    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      errors.push({
        fieldId: field.id,
        message: { en: "Use the format YYYY-MM-DD.", es: "Use el formato AAAA-MM-DD." },
      });
      continue;
    }

    if (field.type === "tel" && !/^\+?[\d\s().-]{7,20}$/.test(value)) {
      errors.push({
        fieldId: field.id,
        message: { en: "Enter a valid phone number.", es: "Ingrese un teléfono válido." },
      });
      continue;
    }

    if (field.type === "select" && field.options) {
      const allowed = field.options.map((option) => option.value);
      if (!allowed.includes(value)) {
        errors.push({
          fieldId: field.id,
          message: {
            en: `Choose one of the listed options for ${field.label.en}.`,
            es: `Elija una de las opciones para ${field.label.es}.`,
          },
        });
      }
      continue;
    }

    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      errors.push({
        fieldId: field.id,
        message: {
          en: `${field.label.en} is not in the expected format.`,
          es: `${field.label.es} no tiene el formato esperado.`,
        },
      });
    }
  }

  return errors;
}

/** Human-readable list of the field labels that will leave the device. */
export function describeSentFields(
  requirements: HospitalIntakeRequirements,
  answers: IntakeAnswers,
  language: Language = "en",
): string[] {
  const all = [...requirements.required, ...requirements.optional];
  return all
    .filter((field) => {
      const value = answers[field.id];
      return typeof value === "string" && value.trim().length > 0;
    })
    .map((field) => field.label[language] ?? field.label.en);
}
