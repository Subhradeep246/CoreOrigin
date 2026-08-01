/**
 * Simulated hospital adapter — DEVELOPMENT AND TESTING ONLY.
 *
 * Nothing here talks to a real hospital. It exists so the full booking flow,
 * including both the `confirmed` and `pending_provider` UI paths, can be
 * exercised without a hospital integration.
 *
 * `getHospitalAdapter()` refuses to return this adapter when
 * PRODUCT_MODE=production. Every result it returns is flagged `simulated: true`
 * and its reference is `MOCK-` prefixed so it can never be mistaken for real.
 *
 * The packet is inspected only for its date. Nothing is logged or retained.
 */

import { randomUUID } from "node:crypto";
import {
  assertNoForbiddenFields,
  intakeField,
} from "@/lib/shared/hospital-intake";
import type {
  AvailabilitySearchInput,
  BookingPacket,
  BookingResult,
  HospitalBookingAdapter,
  HospitalIntakeRequirements,
} from "./types";

const LABEL = "Simulated (development only)";

function buildRequirements(
  hospitalId: string,
  hospitalName: string,
): HospitalIntakeRequirements {
  const requirements: HospitalIntakeRequirements = {
    hospitalId,
    hospitalName,
    required: [
      intakeField("legal_first_name", true),
      intakeField("legal_last_name", true),
      intakeField("date_of_birth", true),
      intakeField("existing_patient", true),
    ],
    optional: [
      intakeField("insurance_member_id", false),
      intakeField("insurance_group_id", false),
      intakeField("subscriber_name", false),
      intakeField("subscriber_relationship", false),
      intakeField("address_city", false),
      intakeField("address_state", false),
      intakeField("administrative_sex", false),
      intakeField("emergency_contact_name", false),
      intakeField("emergency_contact_phone", false),
    ],
    notice: {
      en: "This is a simulated hospital used for development. Nothing is sent to a real clinic and no appointment is made.",
      es: "Este es un hospital simulado para desarrollo. No se envía nada a una clínica real y no se agenda ninguna cita.",
    },
  };

  // Self-check: the mock must obey the same forbidden-field guard as any adapter.
  assertNoForbiddenFields(requirements);
  return requirements;
}

/** Weekday check on an ISO yyyy-mm-dd string, evaluated in UTC. */
function isWeekday(isoDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (Number.isNaN(timestamp)) return false;
  const weekday = new Date(timestamp).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function mockReference(): string {
  return `MOCK-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export const mockAdapter: HospitalBookingAdapter = {
  id: "mock",
  label: LABEL,
  simulated: true,

  async getIntakeRequirements(hospitalId, hospitalName) {
    return buildRequirements(hospitalId, hospitalName);
  },

  async searchAvailability(input: AvailabilitySearchInput) {
    // Fabricated windows, clearly generic, only for weekday dates.
    if (!isWeekday(input.preferredDate)) return { slots: [], checked: true };
    return {
      slots: ["09:00", "11:30", "14:00", "16:15"],
      checked: true,
    };
  },

  async submitBookingRequest(packet: BookingPacket): Promise<BookingResult> {
    const confirmed = isWeekday(packet.preferredDate);

    return {
      status: confirmed ? "confirmed" : "pending_provider",
      reference: mockReference(),
      simulated: true,
      submittedAt: new Date().toISOString(),
      message: confirmed
        ? "Simulated result: a development stand-in confirmed this request. No real clinic was contacted and no appointment exists."
        : "Simulated result: a development stand-in accepted this request as pending. No real clinic was contacted and no appointment exists.",
    };
  },
};

export default mockAdapter;
