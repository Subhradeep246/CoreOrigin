/**
 * POST /api/auth/request-otp — start SMS phone verification.
 *
 * Stateless relay. This route:
 *  - has NO database, NO server session, NO cookie, NO patient record;
 *  - persists nothing, anywhere, ever;
 *  - never logs the phone number (or anything else about the request).
 *
 * SECURITY: the OTP value is generated and held entirely by Twilio Verify. It is
 * never returned, echoed, hinted at, or embedded in any response body, header,
 * or status — in any environment, including development. There is no demo-code
 * path and no "test code" escape hatch.
 */

import { RequestOtpSchema } from "@/lib/shared/schemas";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import { sendOtp, twilioConfigError } from "@/lib/server/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 5 requests per 10 minutes per opaque client key. */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "otp-request"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many requests. Please wait a few minutes and try again.");
  }

  const parsed = await readJson(request, RequestOtpSchema);
  if (!parsed.ok) return parsed.response;

  const configError = twilioConfigError("verify");
  if (configError) return errorResponse(503, configError);

  const result = await sendOtp(parsed.data.phone);
  if (!result.sent) {
    return errorResponse(
      502,
      result.reason ?? "We could not send a verification code right now. Please try again.",
    );
  }

  // Only a boolean leaves this route. Nothing is stored.
  return jsonNoStore({ sent: true });
}
