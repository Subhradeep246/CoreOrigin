import { ensureDatabase, storageBackend } from "@/db/runtime";
import { ELEVENLABS_AGENT_ID, getEnv } from "@/lib/runtime-env";
import { getVerifyServiceSid } from "@/lib/twilio";

export async function GET() {
  let database = true;
  try {
    await ensureDatabase();
  } catch {
    database = false;
  }

  const services = {
    database,
    storage: storageBackend(),
    elevenlabsAgent: Boolean(ELEVENLABS_AGENT_ID),
    privateVoiceSessions: Boolean(getEnv("ELEVENLABS_API_KEY")),
    providerSearch: Boolean(getEnv("NIMBLE_API_KEY")),
    sms:
      Boolean(getEnv("TWILIO_ACCOUNT_SID")) &&
      Boolean(getEnv("TWILIO_API_SECRET") ?? getEnv("TWILIO_AUTH_TOKEN")) &&
      Boolean(getEnv("TWILIO_PHONE_NUMBER") ?? getEnv("TWILIO_MESSAGING_SERVICE_SID") ?? getVerifyServiceSid()),
    otpVerify: Boolean(getVerifyServiceSid()),
    signedTwilioWebhooks: Boolean(getEnv("TWILIO_AUTH_TOKEN")),
    signedElevenLabsWebhooks: Boolean(getEnv("ELEVENLABS_WEBHOOK_SECRET")),
    encryptedContactStorage: Boolean(getEnv("DATA_ENCRYPTION_KEY")),
    registrationSessions: Boolean(getEnv("SESSION_SIGNING_SECRET") ?? getEnv("VOIA_TOOL_SECRET") ?? getEnv("PII_HASH_SALT")),
  };

  const ready = services.database && services.elevenlabsAgent;
  return Response.json(
    {
      status: ready ? "ok" : "degraded",
      mode: getEnv("PRODUCT_MODE") ?? "demo",
      services,
      screening: { enabled: false, reason: "Validated screening model not configured" },
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
