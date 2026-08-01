import { errorResponse } from "@/lib/http";
import { sessionCookieValue, verifyRegistration } from "@/lib/patient-auth";
import { enforceRateLimit, RateLimitError, rateLimitResponse } from "@/lib/rate-limit";
import { registerVerifySchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "register-verify", 10, 3600);
    const input = registerVerifySchema.parse(await request.json());
    const result = await verifyRegistration(input);
    return Response.json(
      {
        status: "registered",
        patient: result.patient,
        message: "Registration complete. You can now use Voia voice, chat, and phone calling.",
      },
      {
        status: 201,
        headers: {
          "set-cookie": sessionCookieValue(result.token),
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof Error && /code|expired|attempts|Incorrect/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return errorResponse(error, "Registration could not be verified");
  }
}
