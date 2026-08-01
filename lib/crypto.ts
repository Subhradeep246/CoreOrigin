import { getEnv } from "./runtime-env";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function patientKey(phone: string, email?: string): Promise<string> {
  const salt = getEnv("PII_HASH_SALT") ?? "voia-development-only";
  const normalized = `${phone.replace(/\D/g, "")}|${email?.trim().toLowerCase() ?? ""}`;
  return sha256(`${salt}|${normalized}`);
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Stable non-identifying label from phone when name is not collected. */
export function patientLabel(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-4) || "0000";
  return `P${tail}`;
}

export async function encryptJson(value: unknown): Promise<string | null> {
  const encodedKey = getEnv("DATA_ENCRYPTION_KEY");
  if (!encodedKey) return null;

  const rawKey = base64ToBytes(encodedKey);
  if (rawKey.byteLength !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
