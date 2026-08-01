/**
 * POST /api/notifications/sms-receipt — optional generic text confirmation.
 *
 * Stateless relay. No database, no server session, no cookie, no patient record.
 * The phone number is relayed to Twilio and dropped; it is never logged or stored.
 *
 * MESSAGE BODY: chosen server-side by `sendGenericReceipt` from a fixed template.
 * The caller cannot supply text — there is no message parameter — so no health
 * concern, symptom, specialty, hospital or provider name, insurance detail, date,
 * time, or booking reference can ever appear in the SMS.
 *
 * `SmsReceiptSchema` requires `smsConsent: true`: separate, explicit consent is
 * mandatory before any text message is sent.
 */

import { SmsReceiptSchema } from "@/lib/shared/schemas";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import { sendGenericReceipt, twilioConfigError } from "@/lib/server/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 5 messages per 10 minutes per opaque client key. */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "sms"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many requests. Please wait a few minutes and try again.");
  }

  const parsed = await readJson(request, SmsReceiptSchema);
  if (!parsed.ok) return parsed.response;

  const configError = twilioConfigError("sms");
  if (configError !== null) return errorResponse(503, configError);

  const result = await sendGenericReceipt(parsed.data.phone, parsed.data.language);

  // Only a boolean leaves this route. Nothing is stored.
  return jsonNoStore({ sent: result.sent });
}
