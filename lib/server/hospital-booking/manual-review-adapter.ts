/**
 * Manual-review adapter — the honest default.
 *
 * This adapter performs NO transmission of any kind. It does not call a hospital
 * API, it does not send SMS, it does not send email, it does not write to a
 * database or the filesystem. Real automated submission requires a secure,
 * approved hospital integration, which this deployment does not have.
 *
 * What it does: record the patient's intent so the request can be shown in the
 * patient's own local history, and return `pending_provider` with a message that
 * states plainly that a Voia coordinator must forward the request before any
 * clinic sees it.
 *
 * It never returns `confirmed`, and it never claims availability.
 */

import { assertNoForbiddenFields, intakeField } from "@/lib/shared/hospital-intake";
import type {
  BookingPacket,
  BookingResult,
  HospitalBookingAdapter,
  HospitalIntakeRequirements,
} from "./types";

const MESSAGE =
  "Your request has been prepared but has NOT been sent to the clinic yet. Voia has no automated connection to this hospital, so a Voia coordinator must forward your request before the clinic sees it. Automated submission requires a secure, approved hospital integration. Nothing was sent by text message or email, and no appointment is booked or held. This request is saved only on your device.";

const MESSAGE_ES =
  "Su solicitud está preparada pero AÚN NO se ha enviado a la clínica. Voia no tiene conexión automática con este hospital, por lo que un coordinador de Voia debe reenviar su solicitud antes de que la clínica la vea. El envío automático requiere una integración hospitalaria segura y aprobada. No se envió nada por mensaje de texto ni correo electrónico, y no hay ninguna cita reservada. Esta solicitud se guarda solo en su dispositivo.";

function buildRequirements(
  hospitalId: string,
  hospitalName: string,
): HospitalIntakeRequirements {
  // Conservative set: only what a coordinator genuinely needs to identify the
  // patient to a clinic. Anything else stays on the device.
  const requirements: HospitalIntakeRequirements = {
    hospitalId,
    hospitalName,
    required: [
      intakeField("legal_first_name", true),
      intakeField("legal_last_name", true),
      intakeField("date_of_birth", true),
    ],
    optional: [
      intakeField("insurance_member_id", false),
      intakeField("existing_patient", false),
    ],
    notice: {
      en: "Voia has no automated connection to this hospital. Your request is reviewed and forwarded by a person, and no appointment is confirmed until the clinic replies to you directly.",
      es: "Voia no tiene conexión automática con este hospital. Una persona revisa y reenvía su solicitud, y ninguna cita se confirma hasta que la clínica le responda directamente.",
    },
  };

  assertNoForbiddenFields(requirements);
  return requirements;
}

export const manualReviewAdapter: HospitalBookingAdapter = {
  id: "manual_review",
  label: "Manual coordinator review",
  simulated: false,

  async getIntakeRequirements(hospitalId, hospitalName) {
    return buildRequirements(hospitalId, hospitalName);
  },

  async searchAvailability() {
    // Availability is never claimed without a real integration.
    return { slots: [], checked: false };
  },

  async submitBookingRequest(packet: BookingPacket): Promise<BookingResult> {
    // No transmission happens here. The packet is not stored, forwarded, or logged.
    return {
      status: "pending_provider",
      simulated: false,
      submittedAt: new Date().toISOString(),
      message: packet.language === "es" ? MESSAGE_ES : MESSAGE,
    };
  },
};

export default manualReviewAdapter;
