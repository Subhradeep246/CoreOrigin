import { createConversationSession } from "@/lib/elevenlabs";
import { errorResponse } from "@/lib/http";
import {
  RegistrationRequiredError,
  requireRegisteredSession,
} from "@/lib/patient-auth";
import { enforceRateLimit, RateLimitError, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "elevenlabs-session", 10, 60);
    const session = await requireRegisteredSession(request);
    const conversation = await createConversationSession();
    return Response.json(
      { ...conversation, patientKey: session.patientKey, phoneLast4: session.phoneLast4 },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof RegistrationRequiredError) {
      return Response.json({ error: error.message, code: "registration_required" }, { status: 401 });
    }
    return errorResponse(error, "Voice assistant is unavailable right now");
  }
}
