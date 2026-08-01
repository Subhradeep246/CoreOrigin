import { insertNotification } from "@/db/repository";
import { sendConversationFollowUp } from "./twilio";
import type { FollowUpMessageInput } from "./validation";

export async function sendCareFollowUpMessage(input: FollowUpMessageInput) {
  const referenceId = input.conversationId
    ? `CONV-${input.conversationId.slice(0, 40)}`
    : `CONV-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

  try {
    const result = await sendConversationFollowUp(input.phone, input.issueKind);
    const status = result.configured ? result.status : "not_configured";
    await insertNotification({
      appointmentId: referenceId,
      providerMessageId: result.configured ? result.sid : undefined,
      status,
    });
    return {
      referenceId,
      sent: result.configured,
      status,
      issueKind: input.issueKind,
      screening: {
        ran: false,
        diseaseInferred: false,
        note: "Voice disease screening is disabled. No disease was inferred from the caller's voice.",
      },
    };
  } catch {
    await insertNotification({ appointmentId: referenceId, status: "failed" });
    return {
      referenceId,
      sent: false,
      status: "failed",
      issueKind: input.issueKind,
      screening: {
        ran: false,
        diseaseInferred: false,
        note: "Voice disease screening is disabled. No disease was inferred from the caller's voice.",
      },
    };
  }
}
