/**
 * POST /api/auth/verify-otp — check a submitted SMS verification code.
 *
 * Stateless relay. No database, no server session, no cookie, no patient record.
 * The phone number and the code are relayed to Twilio Verify and then dropped;
 * neither is logged or persisted.
 *
 * IMPORTANT: this route does NOT set any cookie, does NOT create a session, and
 * does NOT store a patient record. The browser's local vault is the only thing
 * that records that verification happened.
 */

import { VerifyOtpSchema } from "@/lib/shared/schemas";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import { checkOtp, twilioConfigError } from "@/lib/server/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 10 attempts per 10 minutes per opaque client key. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "otp-verify"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many attempts. Please wait a few minutes and try again.");
  }

  const parsed = await readJson(request, VerifyOtpSchema);
  if (!parsed.ok) return parsed.response;

  const configError = twilioConfigError("verify");
  if (configError) return errorResponse(503, configError);

  const result = await checkOtp(parsed.data.phone, parsed.data.code);

  if (!result.approved) {
    return jsonNoStore(
      {
        verified: false,
        error: result.reason ?? "That code is not valid. Please request a new one.",
      },
      { status: 401 },
    );
  }

  // Success is a boolean and nothing more. No cookie is set, no session is
  // created, no record is written. The client stores this in its local vault.
  return jsonNoStore({ verified: true });
}
