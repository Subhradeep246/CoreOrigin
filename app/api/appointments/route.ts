import { createAppointmentRequest, EmergencyRequestError } from "@/lib/appointments";
import { errorResponse } from "@/lib/http";
import {
  RegistrationRequiredError,
  requireRegisteredSession,
} from "@/lib/patient-auth";
import { enforceRateLimit, RateLimitError, rateLimitResponse } from "@/lib/rate-limit";
import { appointmentRequestSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "appointment-request", 5, 3600);
    await requireRegisteredSession(request);
    const input = appointmentRequestSchema.parse(await request.json());
    const appointment = await createAppointmentRequest(input);
    return Response.json({ appointment }, { status: 201 });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof RegistrationRequiredError) {
      return Response.json({ error: error.message, code: "registration_required" }, { status: 401 });
    }
    if (error instanceof EmergencyRequestError) {
      return Response.json(
        { emergency: true, error: error.message, guidance: error.guidance },
        { status: 409 },
      );
    }
    return errorResponse(error, "Appointment request could not be saved");
  }
}
