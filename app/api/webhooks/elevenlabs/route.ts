import { recordWebhookReceipt } from "@/db/repository";
import { sha256 } from "@/lib/crypto";
import { ELEVENLABS_AGENT_ID } from "@/lib/runtime-env";
import { verifyElevenLabsWebhook } from "@/lib/elevenlabs";
import { sendCareFollowUpMessage } from "@/lib/messages";

function extractPhone(data: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    data.phone,
    data.caller_id,
    data.from_number,
    (data.metadata as Record<string, unknown> | undefined)?.phone,
    ((data.metadata as Record<string, unknown> | undefined)?.phone_call as Record<string, unknown> | undefined)
      ?.external_number,
    ((data.metadata as Record<string, unknown> | undefined)?.phone_call as Record<string, unknown> | undefined)
      ?.agent_number,
    (
      (data.conversation_initiation_client_data as Record<string, unknown> | undefined)
        ?.dynamic_variables as Record<string, unknown> | undefined
    )?.phone,
  ];

  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function extractIssueKind(data: Record<string, unknown>): "new" | "continuation" {
  const variables =
    (
      (data.conversation_initiation_client_data as Record<string, unknown> | undefined)
        ?.dynamic_variables as Record<string, unknown> | undefined
    ) ?? {};
  const raw = String(variables.issue_kind ?? variables.issueKind ?? data.issue_kind ?? "").toLowerCase();
  return raw.includes("continu") || raw.includes("follow") ? "continuation" : "new";
}

function smsConsentGranted(data: Record<string, unknown>): boolean {
  const variables =
    (
      (data.conversation_initiation_client_data as Record<string, unknown> | undefined)
        ?.dynamic_variables as Record<string, unknown> | undefined
    ) ?? {};
  const raw = String(variables.sms_consent ?? variables.smsConsent ?? "").toLowerCase();
  return raw === "true" || raw === "yes" || raw === "1";
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("elevenlabs-signature") ?? "";

  try {
    const event = await verifyElevenLabsWebhook(rawBody, signature);
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (typeof data.agent_id === "string" && data.agent_id !== ELEVENLABS_AGENT_ID) {
      return new Response("Forbidden", { status: 403 });
    }

    const conversationId =
      typeof data.conversation_id === "string" ? data.conversation_id : `${event.event_timestamp ?? 0}`;
    const isNew = await recordWebhookReceipt({
      provider: "elevenlabs",
      externalId: conversationId,
      payloadHash: await sha256(rawBody),
      status: event.type ?? "unknown",
    });

    // Deliberately do not persist transcript, audio, or free-text analysis.
    // On first post-call receipt, send a consented SMS follow-up when phone is known.
    let followUp: { sent: boolean; status: string } | undefined;
    const isPostCall =
      typeof event.type === "string" &&
      (event.type.includes("post_call") || event.type.includes("transcription"));

    if (isNew && isPostCall && smsConsentGranted(data)) {
      const phone = extractPhone(data);
      if (phone) {
        const result = await sendCareFollowUpMessage({
          phone,
          issueKind: extractIssueKind(data),
          conversationId,
          consent: { sms: true },
          source: "post_call",
        });
        followUp = { sent: result.sent, status: result.status };
      }
    }

    return Response.json({
      status: "received",
      screening: {
        ran: false,
        diseaseInferred: false,
        note: "Voice disease screening is disabled. No disease was inferred from the caller's voice.",
      },
      followUp,
    });
  } catch {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
}
