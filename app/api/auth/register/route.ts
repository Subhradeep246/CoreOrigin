import { errorResponse } from "@/lib/http";
import { startRegistration } from "@/lib/patient-auth";
import { enforceRateLimit, RateLimitError, rateLimitResponse } from "@/lib/rate-limit";
import { registerStartSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "register-start", 5, 3600);
    const input = registerStartSchema.parse(await request.json());
    const result = await startRegistration({
      phone: input.phone,
      email: input.email || undefined,
      careData: input.consent.careData,
      screening: input.consent.screening,
      sms: input.consent.sms,
    });
    return Response.json({
      ...result,
      next: "Enter the SMS code to finish registration. Calling and chat unlock after verification.",
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    return errorResponse(error, "Registration could not be started");
  }
}
