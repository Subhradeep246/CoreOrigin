import { escapeXml, xmlResponse } from "@/lib/http";
import { assessEmergency } from "@/lib/safety";
import { validateTwilioWebhook } from "@/lib/twilio";
import { getEnv } from "@/lib/runtime-env";

function twiml(message?: string): string {
  return message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const params = Object.fromEntries(
    Array.from(form.entries(), ([key, value]) => [key, typeof value === "string" ? value : value.name]),
  );
  const validation = validateTwilioWebhook(request, params);
  if (!validation.valid) return new Response("Forbidden", { status: 403 });

  const body = params.Body?.trim() ?? "";
  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) return xmlResponse(twiml());
  if (/^(help|info)$/i.test(body)) {
    return xmlResponse(twiml("CoinOrigin appointment help. For emergencies, call your local emergency number. Reply STOP to opt out."));
  }

  const emergency = assessEmergency(body);
  if (emergency.emergency) return xmlResponse(twiml(emergency.message));

  const baseUrl = getEnv("APP_BASE_URL");
  const link = baseUrl?.startsWith("https://") ? ` ${baseUrl}` : "";
  return xmlResponse(
    twiml(`Voia can help with an appointment request.${link} For emergencies, call your local emergency number. Reply STOP to opt out.`),
  );
}
