/**
 * GET /api/health — integration readiness report.
 *
 * Reports only booleans, product-authored messages, and environment variable
 * NAMES. No secret value is ever read into the response: the model NAME is not a
 * secret, but the API key must never appear here (or anywhere else).
 *
 * There is no database to check. Patient data lives only in the encrypted
 * browser-local vault, which is why `storage` is a constant.
 */

import { googleAiConfigError } from "@/lib/server/google-ai";
import { adapterModeError } from "@/lib/server/hospital-booking";
import { jsonNoStore } from "@/lib/server/request-security";
import { tavilyConfigError } from "@/lib/server/tavily";
import { twilioConfigError } from "@/lib/server/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Check = { configured: boolean; error: string | null };

function check(error: string | null): Check {
  return { configured: error === null, error };
}

export async function GET() {
  const checks = {
    googleAi: check(googleAiConfigError()),
    tavily: check(tavilyConfigError()),
    twilioVerify: check(twilioConfigError("verify")),
    twilioSms: check(twilioConfigError("sms")),
    hospitalAdapter: check(adapterModeError()),
  } satisfies Record<string, Check>;

  const degraded = Object.values(checks).some((entry) => entry.error !== null);

  return jsonNoStore({
    status: degraded ? "degraded" : "ok",
    storage: "browser-local-vault",
    productMode: process.env.PRODUCT_MODE ?? "unset",
    model: process.env.GOOGLE_AI_MODEL ?? "unset",
    checks,
  });
}
