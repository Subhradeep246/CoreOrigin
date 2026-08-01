import {
  deleteOtpChallenge,
  getActiveOtpChallenge,
  getRegisteredPatientByKey,
  getRegisteredPatientByPhoneHash,
  incrementOtpAttempts,
  purgeExpiredOtpChallenges,
  replaceOtpChallenge,
  upsertRegisteredPatient,
} from "@/db/repository";
import { encryptJson, patientKey, patientLabel, safeEqual, sha256 } from "./crypto";
import { getEnv } from "./runtime-env";
import { checkVerificationCode, sendSms, sendVerificationCode } from "./twilio";

export const SESSION_COOKIE = "voia_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const TWILIO_VERIFY_MARKER = "twilio-verify";

export type PatientSession = {
  patientKey: string;
  phoneLast4: string;
  exp: number;
};

function sessionSecret(): string {
  return (
    getEnv("SESSION_SIGNING_SECRET") ??
    getEnv("VOIA_TOOL_SECRET") ??
    getEnv("PII_HASH_SALT") ??
    "voia-development-only"
  );
}

async function hmacSign(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodePayload(payload: PatientSession): string {
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodePayload(value: string): PatientSession | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const normalized = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
    return JSON.parse(atob(normalized)) as PatientSession;
  } catch {
    return null;
  }
}

export async function phoneHash(phone: string): Promise<string> {
  const salt = getEnv("PII_HASH_SALT") ?? "voia-development-only";
  return sha256(`${salt}|phone|${phone.replace(/\D/g, "")}`);
}

export function sessionCookieValue(token: string): string {
  const secure = getEnv("PRODUCT_MODE") === "live" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearSessionCookieValue(): string {
  const secure = getEnv("PRODUCT_MODE") === "live" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function createSessionToken(input: {
  patientKey: string;
  phoneLast4: string;
}): Promise<string> {
  const payload: PatientSession = {
    patientKey: input.patientKey,
    phoneLast4: input.phoneLast4,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = encodePayload(payload);
  const signature = await hmacSign(encoded);
  return `${encoded}.${signature}`;
}

export async function readSessionFromRequest(request: Request): Promise<PatientSession | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  const [encoded, signature] = match[1].split(".");
  if (!encoded || !signature) return null;
  const expected = await hmacSign(encoded);
  if (!safeEqual(expected, signature)) return null;
  const payload = decodePayload(encoded);
  if (!payload?.patientKey || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  const patient = await getRegisteredPatientByKey(payload.patientKey);
  if (!patient) return null;
  return payload;
}

function generateOtpCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(value).padStart(6, "0");
}

export async function startRegistration(input: {
  phone: string;
  email?: string;
  careData: true;
  screening: boolean;
  sms: boolean;
}) {
  await purgeExpiredOtpChallenges();
  const hash = await phoneHash(input.phone);
  const demoMode = getEnv("PRODUCT_MODE") !== "live";
  let sent = false;
  let status = "not_sent";
  let channel: "twilio-verify" | "direct-sms" | "demo" = "demo";
  let demoCode: string | undefined;
  let deliveryNote: string | undefined;

  try {
    const verifyResult = await sendVerificationCode(input.phone);
    if (verifyResult.configured) {
      await replaceOtpChallenge({
        id: crypto.randomUUID(),
        phoneHash: hash,
        codeHash: TWILIO_VERIFY_MARKER,
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
        careDataGranted: input.careData,
        screeningGranted: input.screening,
        smsGranted: input.sms,
        email: input.email || undefined,
      });
      sent = true;
      status = verifyResult.status;
      channel = "twilio-verify";
    }
  } catch (error) {
    if (!demoMode) throw error;
    deliveryNote =
      error instanceof Error
        ? error.message
        : "Twilio Verify could not send the code. Use the on-screen code below.";
  }

  if (!sent) {
    const code = generateOtpCode();
    const codeHash = await sha256(`${sessionSecret()}|otp|${hash}|${code}`);
    await replaceOtpChallenge({
      id: crypto.randomUUID(),
      phoneHash: hash,
      codeHash,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      careDataGranted: input.careData,
      screeningGranted: input.screening,
      smsGranted: input.sms,
      email: input.email || undefined,
    });

    if (demoMode) {
      demoCode = code;
      channel = "demo";
      status = "demo_code";
      deliveryNote ??=
        "SMS delivery may be blocked until Twilio A2P 10DLC registration is complete. Use the on-screen code below.";
    }

    try {
      const smsResult = await sendSms(
        input.phone,
        `CoinOrigin code: ${code}. Use it to finish website registration before calling Voia. Expires in 10 minutes.`,
      );
      if (smsResult.configured) {
        sent = true;
        status = smsResult.status;
        channel = "direct-sms";
      } else if (!demoMode) {
        throw new Error("SMS verification is not configured");
      }
    } catch (error) {
      if (!demoMode) throw error;
      deliveryNote =
        error instanceof Error
          ? error.message
          : "Direct SMS failed. Use the on-screen code below.";
      if (!demoCode) demoCode = code;
      channel = "demo";
      status = "demo_code";
    }
  }

  return {
    sent,
    status,
    channel,
    phoneLast4: patientLabel(input.phone).slice(1),
    ...(demoCode ? { demoCode } : {}),
    ...(deliveryNote ? { deliveryNote } : {}),
  };
}

export async function verifyRegistration(input: { phone: string; code: string }) {
  const hash = await phoneHash(input.phone);
  const challenge = await getActiveOtpChallenge(hash);
  if (!challenge) throw new Error("Verification code expired. Request a new code.");
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    await deleteOtpChallenge(challenge.id);
    throw new Error("Too many attempts. Request a new code.");
  }

  const expected = await sha256(`${sessionSecret()}|otp|${hash}|${input.code.trim()}`);
  let verified = false;
  if (challenge.codeHash === TWILIO_VERIFY_MARKER) {
    const verifyResult = await checkVerificationCode(input.phone, input.code);
    verified = verifyResult.approved;
  } else if (safeEqual(expected, challenge.codeHash)) {
    verified = true;
  }

  if (!verified) {
    await incrementOtpAttempts(challenge.id, challenge.attempts + 1);
    throw new Error("Incorrect verification code.");
  }

  const key = await patientKey(input.phone, challenge.email || undefined);
  const encryptedContact = await encryptJson({
    phone: input.phone,
    email: challenge.email || undefined,
  });
  const verifiedAt = new Date().toISOString();
  const patient = await upsertRegisteredPatient({
    patientKey: key,
    phoneHash: hash,
    phoneLast4: input.phone.replace(/\D/g, "").slice(-4),
    encryptedContact,
    careDataGranted: challenge.careDataGranted,
    screeningGranted: challenge.screeningGranted,
    smsGranted: challenge.smsGranted,
    policyVersion: "2026-07-11",
    verifiedAt,
  });
  await deleteOtpChallenge(challenge.id);

  const token = await createSessionToken({
    patientKey: patient.patientKey,
    phoneLast4: patient.phoneLast4,
  });

  return {
    token,
    patient: {
      phoneLast4: patient.phoneLast4,
      verifiedAt: patient.verifiedAt,
      careDataGranted: patient.careDataGranted,
      screeningGranted: patient.screeningGranted,
      smsGranted: patient.smsGranted,
    },
  };
}

export async function isPhoneRegistered(phone: string): Promise<boolean> {
  const hash = await phoneHash(phone);
  return Boolean(await getRegisteredPatientByPhoneHash(hash));
}

export async function requireRegisteredSession(request: Request): Promise<PatientSession> {
  const session = await readSessionFromRequest(request);
  if (!session) {
    throw new RegistrationRequiredError();
  }
  return session;
}

export class RegistrationRequiredError extends Error {
  status = 401;

  constructor() {
    super("Register on the website before using Voia voice, chat, or phone calling.");
  }
}
