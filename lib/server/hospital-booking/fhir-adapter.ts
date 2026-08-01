/**
 * FHIR / SMART-on-FHIR adapter — TYPED STUB, NOT AN INTEGRATION.
 *
 * This file deliberately contains no endpoint URLs, no credentials, no token
 * exchange, and no fake booking behaviour. It exists so the adapter contract is
 * ready the day a hospital signs off, and so nothing in the product can pretend
 * a real scheduling connection exists.
 *
 * To enable this adapter a hospital must provide ALL of the following:
 *
 *  1. Written approval to submit appointment requests on a patient's behalf,
 *     plus a signed agreement (BAA or equivalent data-processing agreement).
 *  2. The base FHIR R4 service URL for their scheduling environment
 *     (`VOIA_FHIR_BASE_URL`), and confirmation of which resources are exposed:
 *     `Slot`, `Schedule`, `Appointment`, and `Patient` $match or equivalent.
 *  3. SMART-on-FHIR backend-services client credentials
 *     (`VOIA_FHIR_CLIENT_ID`, plus a registered JWKS or client secret) with the
 *     scopes required to read `Slot`/`Schedule` and create `Appointment`.
 *  4. The authorization/token endpoint, or a published SMART configuration
 *     document, and the allow-listed source IPs or mTLS material they require.
 *  5. A reference to the executed agreement (`VOIA_FHIR_AGREEMENT_REF`) so the
 *     deployment can prove the integration is authorised.
 *
 * Until every item above exists in configuration, every method here refuses.
 * The config keys are intentionally absent from `.env.example`.
 */

import type {
  BookingPacket,
  BookingResult,
  HospitalBookingAdapter,
  HospitalIntakeRequirements,
} from "./types";

const REQUIRED_CONFIG_KEYS = [
  "VOIA_FHIR_BASE_URL",
  "VOIA_FHIR_CLIENT_ID",
  "VOIA_FHIR_TOKEN_URL",
  "VOIA_FHIR_AGREEMENT_REF",
] as const;

const REFUSAL =
  "Direct hospital scheduling is not enabled. A real FHIR integration requires written hospital approval, a signed data-processing agreement, a base FHIR R4 service URL, and SMART-on-FHIR client credentials. None of that configuration is present, so Voia will not attempt a submission or imply one occurred.";

const REFUSAL_ES =
  "La programación directa con el hospital no está habilitada. Una integración FHIR real requiere aprobación escrita del hospital, un acuerdo firmado de tratamiento de datos, una URL base del servicio FHIR R4 y credenciales SMART-on-FHIR. Nada de esa configuración está presente, por lo que Voia no intentará ningún envío ni dará a entender que se realizó.";

/** Which required integration keys are missing. Names only, never values. */
export function fhirConfigMissing(): string[] {
  return REQUIRED_CONFIG_KEYS.filter((key) => {
    const value = process.env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

/** Config error for the UI, or `null` if a hospital has fully provisioned it. */
export function fhirConfigError(): string | null {
  const missing = fhirConfigMissing();
  if (missing.length === 0) {
    // Configuration alone is not enough: the transport itself is unimplemented.
    return "A FHIR configuration is present, but the FHIR transport is not implemented in this build.";
  }
  return `${REFUSAL} Missing configuration: ${missing.join(", ")}.`;
}

export const fhirAdapter: HospitalBookingAdapter = {
  id: "fhir",
  label: "Hospital FHIR integration (not enabled)",
  simulated: false,

  async getIntakeRequirements(
    _hospitalId: string,
    _hospitalName: string,
  ): Promise<HospitalIntakeRequirements> {
    // Field requirements come from the hospital's own registration rules; with
    // no approved integration there is nothing legitimate to declare.
    throw new Error(REFUSAL);
  },

  async searchAvailability() {
    // Availability is never claimed, and never guessed.
    return { slots: [], checked: false };
  },

  async submitBookingRequest(packet: BookingPacket): Promise<BookingResult> {
    // Nothing is transmitted, stored, or logged. The packet is not inspected
    // beyond its language, purely to pick the refusal wording.
    return {
      status: "unavailable",
      simulated: false,
      submittedAt: new Date().toISOString(),
      message: packet.language === "es" ? REFUSAL_ES : REFUSAL,
    };
  },
};

export default fhirAdapter;
