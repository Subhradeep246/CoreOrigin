import { updateNotificationStatus } from "@/db/repository";
import { validateTwilioWebhook } from "@/lib/twilio";

export async function POST(request: Request) {
  const form = await request.formData();
  const params = Object.fromEntries(
    Array.from(form.entries(), ([key, value]) => [key, typeof value === "string" ? value : value.name]),
  );
  if (!validateTwilioWebhook(request, params).valid) {
    return new Response("Forbidden", { status: 403 });
  }

  if (params.MessageSid && params.MessageStatus) {
    await updateNotificationStatus({
      providerMessageId: params.MessageSid,
      status: params.MessageStatus,
      errorCode: params.ErrorCode || undefined,
    });
  }
  return new Response(null, { status: 204 });
}
