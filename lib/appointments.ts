import { insertAppointment, insertNotification } from "@/db/repository";
import { encryptJson, patientKey, patientLabel } from "./crypto";
import { getEnv } from "./runtime-env";
import { assessEmergency } from "./safety";
import { sendAppointmentReceipt, sendHospitalAppointmentRequest } from "./twilio";
import type { AppointmentRequestInput } from "./validation";

export class EmergencyRequestError extends Error {
  guidance: string;

  constructor(guidance: string) {
    super("Routine booking stopped because symptoms may be an emergency");
    this.guidance = guidance;
  }
}

export async function createAppointmentRequest(input: AppointmentRequestInput) {
  const assessment = assessEmergency(input.reason);
  if (assessment.emergency) {
    throw new EmergencyRequestError(assessment.message ?? "Call your local emergency number now.");
  }

  const today = new Date().toISOString().slice(0, 10);
  if (input.requestedDate < today) {
    throw new Error("Requested date must be today or later");
  }

  const key = await patientKey(input.phone, input.email || undefined);
  const encryptedContact = await encryptJson({
    phone: input.phone,
    email: input.email || undefined,
  });
  if (getEnv("PRODUCT_MODE") === "live" && !encryptedContact) {
    throw new Error("Live appointment storage requires DATA_ENCRYPTION_KEY");
  }

  const id = `VOIA-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const row = await insertAppointment(
    {
      id,
      patientKey: key,
      patientInitials: patientLabel(input.phone),
      encryptedContact,
      specialty: input.specialty,
      providerId: input.provider?.id,
      providerName: input.provider?.name,
      facilityName: input.provider?.facilityName,
      providerPhone: input.provider?.phone,
      providerWebsite: input.provider?.website,
      address: input.provider?.address,
      location: input.location,
      modality: input.modality,
      requestedDate: input.requestedDate,
      timeWindow: input.timeWindow,
      timezone: input.timezone,
      reasonCategory: input.reasonCategory,
      insurance: input.insurance,
      issueKind: input.issueKind,
      status: "pending_provider",
      source: input.source,
    },
    {
      patientKey: key,
      careDataGranted: input.consent.careData,
      screeningGranted: input.consent.screening,
      smsGranted: input.consent.sms,
      policyVersion: "2026-07-11",
      channel: input.source,
    },
  );

  let hospitalNotification: { sent: boolean; status: string } = { sent: false, status: "not_requested" };
  try {
    const hospitalResult = await sendHospitalAppointmentRequest({
      appointmentId: id,
      patientPhone: input.phone,
      patientEmail: input.email || undefined,
      insurance: input.insurance,
      specialty: input.specialty,
      location: input.location,
      reasonCategory: input.reasonCategory,
      issueKind: input.issueKind,
      modality: input.modality,
      requestedDate: input.requestedDate,
      timeWindow: input.timeWindow,
      timezone: input.timezone,
      providerName: input.provider?.name,
      facilityName: input.provider?.facilityName,
      providerAddress: input.provider?.address,
    });
    hospitalNotification = hospitalResult.configured
      ? { sent: true, status: hospitalResult.status }
      : { sent: false, status: "not_configured" };
    await insertNotification({
      appointmentId: id,
      providerMessageId: hospitalResult.configured ? hospitalResult.sid : undefined,
      status: hospitalResult.configured ? hospitalResult.status : "not_configured",
      channel: "hospital_sms",
    });
  } catch {
    hospitalNotification = { sent: false, status: "failed" };
    await insertNotification({ appointmentId: id, status: "failed", channel: "hospital_sms" });
  }

  let sms: { sent: boolean; status: string } = { sent: false, status: "not_requested" };
  if (input.consent.sms) {
    try {
      const result = await sendAppointmentReceipt(input.phone, id, input.issueKind);
      sms = result.configured
        ? { sent: true, status: result.status }
        : { sent: false, status: "not_configured" };
      await insertNotification({
        appointmentId: id,
        providerMessageId: result.configured ? result.sid : undefined,
        status: result.configured ? result.status : "not_configured",
        channel: "patient_sms",
      });
    } catch {
      sms = { sent: false, status: "failed" };
      await insertNotification({ appointmentId: id, status: "failed", channel: "patient_sms" });
    }
  }

  return {
    id: row.id,
    status: row.status,
    specialty: row.specialty,
    provider: row.providerName,
    requestedDate: row.requestedDate,
    timeWindow: row.timeWindow,
    timezone: row.timezone,
    issueKind: row.issueKind,
    insurance: row.insurance,
    sms,
    hospitalNotification,
    screening: {
      ran: false,
      diseaseInferred: false,
      note: "Voice disease screening is disabled. No disease was inferred from the caller's voice.",
    },
    disclaimer:
      "Request received. Appointment is not booked until the provider confirms a specific date and time.",
  };
}
