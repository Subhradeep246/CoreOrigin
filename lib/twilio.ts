import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import { hospitalBookingPhone } from "./hospital-booking";
import { getEnv, envFlag } from "./runtime-env";
import { publicRequestUrl } from "./http";

type TwilioSendResult =
  | { configured: false }
  | { configured: true; sid: string; status: string };

type TwilioVerifyResult =
  | { configured: false }
  | { configured: true; sid: string; status: string; channel: string };

function twilioCredentials(): {
  accountSid?: string;
  username?: string;
  password?: string;
  authorization?: string;
} {
  const accountSid = getEnv("TWILIO_ACCOUNT_SID");
  const apiKey = getEnv("TWILIO_API_KEY");
  const apiSecret = getEnv("TWILIO_API_SECRET");
  const authToken = getEnv("TWILIO_AUTH_TOKEN");
  const username = apiKey ?? accountSid;
  const password = apiSecret ?? authToken;
  if (!accountSid || !username || !password) return { accountSid };
  return {
    accountSid,
    username,
    password,
    authorization: `Basic ${btoa(`${username}:${password}`)}`,
  };
}

export function getVerifyServiceSid(): string | undefined {
  return getEnv("TWILIO_VERIFY_SERVICE_SID");
}

export async function sendSms(to: string, body: string): Promise<TwilioSendResult> {
  const { accountSid, authorization } = twilioCredentials();
  const from = getEnv("TWILIO_PHONE_NUMBER");
  const messagingServiceSid = getEnv("TWILIO_MESSAGING_SERVICE_SID");

  if (!accountSid || !authorization || (!from && !messagingServiceSid)) {
    return { configured: false };
  }

  const form = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
  else if (from) form.set("From", from);

  const baseUrl = getEnv("APP_BASE_URL");
  if (baseUrl?.startsWith("https://")) {
    form.set("StatusCallback", `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio/status`);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: form,
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    code?: number;
    message?: string;
  };
  if (!response.ok || !payload.sid) {
    const detail = payload.message ? `: ${payload.message}` : "";
    throw new Error(`SMS delivery request failed${payload.code ? ` (${payload.code})` : ""}${detail}`);
  }
  return { configured: true, sid: payload.sid, status: payload.status ?? "queued" };
}

export async function sendVerificationCode(phone: string): Promise<TwilioVerifyResult> {
  const serviceSid = getVerifyServiceSid();
  const { authorization } = twilioCredentials();
  if (!serviceSid || !authorization) return { configured: false };

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/Verifications`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ To: phone, Channel: "sms" }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    channel?: string;
    code?: number;
    message?: string;
  };
  if (!response.ok || !payload.sid) {
    const detail = payload.message ? `: ${payload.message}` : "";
    throw new Error(`Verification SMS failed${payload.code ? ` (${payload.code})` : ""}${detail}`);
  }
  return {
    configured: true,
    sid: payload.sid,
    status: payload.status ?? "pending",
    channel: payload.channel ?? "sms",
  };
}

export async function checkVerificationCode(
  phone: string,
  code: string,
): Promise<{ approved: boolean; status: string }> {
  const serviceSid = getVerifyServiceSid();
  const { authorization } = twilioCredentials();
  if (!serviceSid || !authorization) {
    return { approved: false, status: "not_configured" };
  }

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ To: phone, Code: code.trim() }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    status?: string;
    valid?: boolean;
    code?: number;
    message?: string;
  };
  if (!response.ok) {
    const detail = payload.message ? `: ${payload.message}` : "";
    throw new Error(`Verification check failed${payload.code ? ` (${payload.code})` : ""}${detail}`);
  }
  const status = payload.status ?? "pending";
  return { approved: status === "approved", status };
}

export async function sendHospitalAppointmentRequest(input: {
  appointmentId: string;
  patientPhone: string;
  patientEmail?: string;
  insurance: string;
  specialty: string;
  location: string;
  reasonCategory: string;
  issueKind: "new" | "continuation";
  modality: string;
  requestedDate: string;
  timeWindow: string;
  timezone: string;
  providerName?: string;
  facilityName?: string;
  providerAddress?: string;
}): Promise<TwilioSendResult> {
  const providerLine = input.providerName
    ? `${input.providerName}${input.facilityName ? ` (${input.facilityName})` : ""}`
    : "No provider preference";
  const addressLine = input.providerAddress ? `Address: ${input.providerAddress}\n` : "";
  const emailLine = input.patientEmail ? `Email: ${input.patientEmail}\n` : "";

  const body = [
    `CoinOrigin appointment request ${input.appointmentId}`,
    `Insurance: ${input.insurance}`,
    `Patient phone: ${input.patientPhone}`,
    emailLine.trim(),
    `Specialty: ${input.specialty}`,
    `Provider: ${providerLine}`,
    addressLine.trim(),
    `Preferred: ${input.requestedDate}, ${input.timeWindow}, ${input.timezone}`,
    `Visit: ${input.modality}`,
    `Issue: ${input.issueKind === "continuation" ? "continuation" : "new"} concern`,
    `Reason: ${input.reasonCategory}`,
    `Location: ${input.location}`,
    "Status: pending provider confirmation",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1500);

  return sendSms(hospitalBookingPhone(), body);
}

export async function sendAppointmentReceipt(
  phone: string,
  appointmentId: string,
  issueKind: "new" | "continuation",
): Promise<TwilioSendResult> {
  const kindLabel = issueKind === "continuation" ? "follow-up concern" : "new concern";
  return sendSms(
    phone,
    `CoinOrigin received request ${appointmentId} (${kindLabel}). Voice disease screening did not run—no disease was inferred from your voice. Not a confirmed booking. Reply STOP to opt out.`,
  );
}

export async function sendConversationFollowUp(
  phone: string,
  issueKind: "new" | "continuation",
): Promise<TwilioSendResult> {
  const kindLabel = issueKind === "continuation" ? "a continuation of a prior concern" : "a new concern";
  return sendSms(
    phone,
    `CoinOrigin: Thanks for talking with Voia. We recorded this as ${kindLabel}. Voice disease screening did not run—no disease was inferred from your voice. Reply STOP to opt out.`,
  );
}

export function validateTwilioWebhook(
  request: Request,
  params: Record<string, string>,
): { valid: boolean; configured: boolean } {
  const enforce = envFlag("TWILIO_VALIDATE_SIGNATURES", true);
  if (!enforce && getEnv("PRODUCT_MODE") !== "live") {
    return { valid: true, configured: false };
  }

  const authToken = getEnv("TWILIO_AUTH_TOKEN");
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!authToken || !signature) return { valid: false, configured: Boolean(authToken) };

  const configuredBase = getEnv("APP_BASE_URL")?.replace(/\/$/, "");
  const requestUrl = new URL(request.url);
  const validationUrl = configuredBase
    ? `${configuredBase}${requestUrl.pathname}${requestUrl.search}`
    : publicRequestUrl(request);

  return {
    valid: validateRequest(authToken, signature, validationUrl, params),
    configured: true,
  };
}
