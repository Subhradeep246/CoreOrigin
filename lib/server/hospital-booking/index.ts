/**
 * Hospital adapter selection.
 *
 * `HOSPITAL_BOOKING_MODE` picks the adapter: `manual_review` (default), `mock`,
 * or `fhir`.
 *
 * CRITICAL: the simulated mock adapter is impossible in production. If
 * `PRODUCT_MODE === "production"` and the mode is `mock`, `getHospitalAdapter()`
 * throws rather than degrading to something that could tell a real patient their
 * appointment is confirmed.
 */

import { fhirAdapter, fhirConfigError } from "./fhir-adapter";
import { manualReviewAdapter } from "./manual-review-adapter";
import { mockAdapter } from "./mock-adapter";
import type { HospitalBookingAdapter } from "./types";

export type HospitalBookingMode = "manual_review" | "mock" | "fhir";

const MODES: readonly HospitalBookingMode[] = ["manual_review", "mock", "fhir"] as const;

function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function rawMode(): string {
  return env("HOSPITAL_BOOKING_MODE") || "manual_review";
}

function isProduction(): boolean {
  return env("PRODUCT_MODE") === "production";
}

/** The configured mode, or `null` when the value is not recognised. */
export function hospitalBookingMode(): HospitalBookingMode | null {
  const mode = rawMode();
  return (MODES as readonly string[]).includes(mode) ? (mode as HospitalBookingMode) : null;
}

/**
 * Config problem to surface in the UI, or `null` when the setup is coherent.
 * Returns names and modes only — never a secret value.
 */
export function adapterModeError(): string | null {
  const mode = hospitalBookingMode();

  if (mode === null) {
    return `HOSPITAL_BOOKING_MODE is not a recognised value. Use one of: ${MODES.join(", ")}.`;
  }

  if (mode === "mock" && isProduction()) {
    return "HOSPITAL_BOOKING_MODE=mock is refused when PRODUCT_MODE=production. The simulated adapter must never serve real patients.";
  }

  if (mode === "mock") {
    return "Booking is running against the simulated adapter. No real clinic is contacted and no appointment is made.";
  }

  if (mode === "fhir") {
    return fhirConfigError();
  }

  return null;
}

/**
 * Resolve the active adapter.
 *
 * Throws on an unrecognised mode, and throws hard if `mock` is requested in
 * production. Callers should treat a throw as a configuration error and return
 * a generic message to the client.
 */
export function getHospitalAdapter(): HospitalBookingAdapter {
  const mode = hospitalBookingMode();

  if (mode === null) {
    throw new Error(
      `Unsupported HOSPITAL_BOOKING_MODE. Use one of: ${MODES.join(", ")}.`,
    );
  }

  if (mode === "mock") {
    if (isProduction()) {
      throw new Error(
        "Refusing to use the simulated booking adapter: PRODUCT_MODE=production with HOSPITAL_BOOKING_MODE=mock. Set HOSPITAL_BOOKING_MODE=manual_review.",
      );
    }
    return mockAdapter;
  }

  if (mode === "fhir") return fhirAdapter;

  return manualReviewAdapter;
}

export { fhirAdapter, fhirConfigError, manualReviewAdapter, mockAdapter };
export type {
  AvailabilitySearchInput,
  BookingPacket,
  BookingResult,
  BookingStatus,
  HospitalBookingAdapter,
  HospitalIntakeRequirements,
} from "./types";
