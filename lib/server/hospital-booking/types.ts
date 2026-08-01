/**
 * Hospital scheduling adapter contract.
 *
 * An adapter is the ONLY thing allowed to report a booking outcome. Voia never
 * claims an appointment is booked on its own: the status comes from here, and
 * only `confirmed | pending_provider | unavailable` exist.
 *
 * Adapters are stateless. They may not write to a database or the filesystem,
 * and they may not log any part of a `BookingPacket`.
 */

import type {
  BookingPacket,
  BookingResult,
  BookingStatus,
  HospitalIntakeRequirements,
  Modality,
} from "@/lib/shared/types";

export type { BookingPacket, BookingResult, BookingStatus, HospitalIntakeRequirements };

/**
 * Availability probe input. Deliberately free of identifiers: an adapter never
 * needs a name, phone, email, DOB, or insurance id to look for open slots.
 */
export type AvailabilitySearchInput = {
  hospitalId: string;
  hospitalName: string;
  specialty: string;
  /** ISO yyyy-mm-dd. */
  preferredDate: string;
  preferredTimeWindow: string;
  modality: Modality;
  timezone: string;
};

export interface HospitalBookingAdapter {
  /** Stable adapter id, e.g. "manual_review". */
  id: string;
  /** Human label shown in the UI. Simulated adapters must say so. */
  label: string;
  /** True only for development simulations. Must be surfaced to the patient. */
  simulated: boolean;

  /** Which stage-2 fields this hospital requires. Must pass `assertNoForbiddenFields`. */
  getIntakeRequirements(
    hospitalId: string,
    hospitalName: string,
  ): Promise<HospitalIntakeRequirements>;

  /**
   * Look for open slots. `checked: false` means availability was never verified —
   * callers must not present slots or imply availability in that case.
   */
  searchAvailability(
    input: AvailabilitySearchInput,
  ): Promise<{ slots: string[]; checked: boolean }>;

  /** Submit the request. The returned status is authoritative. */
  submitBookingRequest(packet: BookingPacket): Promise<BookingResult>;
}
