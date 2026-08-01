/**
 * Twilio bridge — SERVER ONLY.
 *
 * Twilio is used for exactly two things:
 *  1. Verify OTP, to prove the patient controls the phone number.
 *  2. An optional, fixed-template SMS receipt.
 *
 * Hard rules enforced here:
 *  - The phone number and the OTP code are NEVER logged, cached, or persisted.
 *  - The SMS body is chosen server-side from a fixed template. Callers cannot
 *    supply text, so no symptom, specialty, hospital name, insurance detail,
 *    date, time, or booking reference can ever appear in a text message.
 *  - Upstream errors are reduced to a generic reason string. Twilio error bodies
 *    can echo the destination number, so they are never surfaced or logged.
 */

import twilio from "twilio";

type Purpose = "verify" | "sms";

function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Fixed SMS templates. Intentionally content-free: they confirm that a request
 * was sent and point the patient back to their own device, nothing more.
 */
const RECEIPT_TEMPLATES = {
  en: "Voia: Your appointment request was sent. Open Voia on this device to view details. Reply STOP to opt out.",
  es: "Voia: Su solicitud de cita fue enviada. Abra Voia en este dispositivo para ver los detalles. Responda STOP para darse de baja.",
} as const;

const GENERIC_FAILURE = "The message service is temporarily unavailable. Please try again.";

/**
 * Why Twilio cannot be used for `purpose`, or `null` when it can.
 *
 * API-key/secret auth still requires the account SID to scope the request, so an
 * empty `TWILIO_ACCOUNT_SID` is reported explicitly.
 */
export function twilioConfigError(purpose: Purpose): string | null {
  const missing: string[] = [];

  if (!env("TWILIO_ACCOUNT_SID")) missing.push("TWILIO_ACCOUNT_SID");
  if (!env("TWILIO_API_KEY")) missing.push("TWILIO_API_KEY");
  if (!env("TWILIO_API_SECRET")) missing.push("TWILIO_API_SECRET");

  if (purpose === "verify" && !env("TWILIO_VERIFY_SERVICE_SID")) {
    missing.push("TWILIO_VERIFY_SERVICE_SID");
  }

  if (
    purpose === "sms" &&
    !env("TWILIO_MESSAGING_SERVICE_SID") &&
    !env("TWILIO_PHONE_NUMBER")
  ) {
    missing.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER");
  }

  if (missing.length === 0) return null;

  const label = purpose === "verify" ? "Phone verification" : "SMS receipts";
  return `${label} is not configured on this server. Missing: ${missing.join(", ")}. API-key authentication also requires the account SID.`;
}

/** Build a client lazily. Credentials are read per call, never at module load. */
function createClient(): ReturnType<typeof twilio> {
  return twilio(env("TWILIO_API_KEY"), env("TWILIO_API_SECRET"), {
    accountSid: env("TWILIO_ACCOUNT_SID"),
  });
}

/* ------------------------------------------------------------------ */
/* Verify                                                              */
/* ------------------------------------------------------------------ */

/** Start an SMS verification. The number is passed through, never retained. */
export async function sendOtp(phone: string): Promise<{ sent: boolean; reason?: string }> {
  const configError = twilioConfigError("verify");
  if (configError) return { sent: false, reason: configError };

  try {
    const client = createClient();
    await client.verify.v2
      .services(env("TWILIO_VERIFY_SERVICE_SID"))
      .verifications.create({ to: phone, channel: "sms" });
    return { sent: true };
  } catch {
    // Never log or inspect the error: Twilio error bodies contain the number.
    return {
      sent: false,
      reason: "We could not send a verification code right now. Please try again.",
    };
  }
}

/** Check a submitted OTP. Neither the number nor the code is logged or stored. */
export async function checkOtp(
  phone: string,
  code: string,
): Promise<{ approved: boolean; reason?: string }> {
  const configError = twilioConfigError("verify");
  if (configError) return { approved: false, reason: configError };

  try {
    const client = createClient();
    const check = await client.verify.v2
      .services(env("TWILIO_VERIFY_SERVICE_SID"))
      .verificationChecks.create({ to: phone, code });

    if (check.status === "approved" && check.valid) return { approved: true };
    return { approved: false, reason: "That code is not valid. Please request a new one." };
  } catch {
    return {
      approved: false,
      reason: "We could not check that code right now. Please request a new one.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Generic receipt                                                     */
/* ------------------------------------------------------------------ */

/**
 * Send the fixed receipt template.
 *
 * The body is selected here, server-side, from `RECEIPT_TEMPLATES`. There is no
 * parameter for message text: a caller cannot inject a symptom, health concern,
 * specialty, provider or hospital name, insurance detail, date, time, or any
 * other booking detail into an SMS.
 */
export async function sendGenericReceipt(
  phone: string,
  language: "en" | "es",
): Promise<{ sent: boolean; reason?: string }> {
  const configError = twilioConfigError("sms");
  if (configError) return { sent: false, reason: configError };

  const body = RECEIPT_TEMPLATES[language] ?? RECEIPT_TEMPLATES.en;
  const messagingServiceSid = env("TWILIO_MESSAGING_SERVICE_SID");
  const from = env("TWILIO_PHONE_NUMBER");

  try {
    const client = createClient();
    await client.messages.create(
      messagingServiceSid
        ? { to: phone, body, messagingServiceSid }
        : { to: phone, body, from },
    );
    return { sent: true };
  } catch {
    return { sent: false, reason: GENERIC_FAILURE };
  }
}
