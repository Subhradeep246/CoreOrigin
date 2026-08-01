import { safeEqual } from "./crypto";
import { ELEVENLABS_AGENT_ID, getEnv } from "./runtime-env";

const API_BASE = "https://api.elevenlabs.io/v1";

export async function createConversationSession(): Promise<
  | { mode: "public"; agentId: string }
  | { mode: "private"; conversationToken: string }
> {
  const apiKey = getEnv("ELEVENLABS_API_KEY");
  if (!apiKey) return { mode: "public", agentId: ELEVENLABS_AGENT_ID };

  const url = new URL(`${API_BASE}/convai/conversation/token`);
  url.searchParams.set("agent_id", ELEVENLABS_AGENT_ID);
  const response = await fetch(url, { headers: { "xi-api-key": apiKey } });
  if (!response.ok) throw new Error(`Voice session unavailable (${response.status})`);
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) throw new Error("Voice session token missing");
  return { mode: "private", conversationToken: payload.token };
}

export async function registerTwilioCall(input: {
  from: string;
  to: string;
  direction: string;
}): Promise<string> {
  const apiKey = getEnv("ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("Phone agent is not configured");
  const response = await fetch(`${API_BASE}/convai/twilio/register-call`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: ELEVENLABS_AGENT_ID,
      from_number: input.from,
      to_number: input.to,
      direction: input.direction === "outbound-api" ? "outbound" : "inbound",
      conversation_initiation_client_data: {
        dynamic_variables: { channel: "phone", registered: "true" },
      },
    }),
  });
  if (!response.ok) throw new Error(`Phone agent unavailable (${response.status})`);
  return response.text();
}

export async function verifyElevenLabsWebhook(rawBody: string, signature: string) {
  const secret = getEnv("ELEVENLABS_WEBHOOK_SECRET");
  if (!secret) throw new Error("ElevenLabs webhook verification is not configured");
  const parts = signature.split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const supplied = parts.find((part) => part.startsWith("v0="));
  if (!timestamp || !supplied) throw new Error("Invalid ElevenLabs signature header");

  const requestTime = Number(timestamp) * 1000;
  if (!Number.isFinite(requestTime) || requestTime < Date.now() - 30 * 60 * 1000) {
    throw new Error("ElevenLabs webhook timestamp is outside tolerance");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)),
  );
  const expected = `v0=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!safeEqual(supplied, expected)) throw new Error("Invalid ElevenLabs webhook signature");

  return JSON.parse(rawBody) as {
    type?: string;
    event_timestamp?: number;
    data?: Record<string, unknown> & {
      conversation_id?: string;
      agent_id?: string;
      status?: string;
    };
  };
}
