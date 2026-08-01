/**
 * POST /api/appointments/submit — hand the booking request to the hospital adapter.
 *
 * Stateless relay. No database, no server session, no cookie, no patient record.
 * The packet is validated, passed to the adapter, and dropped. Nothing about it
 * is written to disk, to a store, or to a log — not the phone number, name, DOB,
 * address, insurance detail, reason for visit, or intake answers.
 *
 * PERSISTS NOTHING: the browser stores the outcome in its own encrypted local
 * vault. This route keeps no copy of the packet or the result.
 *
 * `SubmitBookingSchema` requires `hospitalSharingConsent: true`, so the patient
 * has explicitly authorised contacting the hospital before we get here.
 */

import { checkEmergencyAcross } from "@/lib/shared/safety";
import { SubmitBookingSchema } from "@/lib/shared/schemas";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import {
  getHospitalAdapter,
  type HospitalBookingAdapter,
} from "@/lib/server/hospital-booking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 10 submissions per 10 minutes per opaque client key. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "submit"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many requests. Please wait a few minutes and try again.");
  }

  const parsed = await readJson(request, SubmitBookingSchema);
  if (!parsed.ok) return parsed.response;
  const packet = parsed.data.packet;

  // Emergency gate runs BEFORE the adapter. An emergency is never queued as an
  // appointment request.
  const emergency = checkEmergencyAcross(
    [packet.reasonForVisit, packet.accessibilityNeeds],
    packet.language,
  );
  if (emergency.emergency) {
    return jsonNoStore({ emergency: true, guidance: emergency.guidance });
  }

  // A throw here is a configuration error (e.g. the simulated adapter requested
  // in production). Surface a generic message; never the exception text.
  let adapter: HospitalBookingAdapter;
  try {
    adapter = getHospitalAdapter();
  } catch {
    return errorResponse(
      503,
      "Booking is not configured on this server right now. Please try again later or contact the clinic directly.",
    );
  }

  const result = await adapter.submitBookingRequest(packet);

  // The adapter's status is authoritative and returned verbatim. This route must
  // never translate `pending_provider` into "booked" or "confirmed" language.
  return jsonNoStore({
    result,
    adapter: {
      id: adapter.id,
      label: adapter.label,
      simulated: adapter.simulated,
    },
  });
}
