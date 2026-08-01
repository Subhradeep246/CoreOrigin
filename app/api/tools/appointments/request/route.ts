import { createAppointmentRequest, EmergencyRequestError } from "@/lib/appointments";
import { authorizeToolRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { appointmentRequestSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const auth = authorizeToolRequest(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const input = appointmentRequestSchema.parse({
      ...payload,
      source: "agent_tool",
    });
    return Response.json({ appointment: await createAppointmentRequest(input) }, { status: 201 });
  } catch (error) {
    if (error instanceof EmergencyRequestError) {
      return Response.json(
        { emergency: true, guidance: error.guidance, routine_booking_stopped: true },
        { status: 409 },
      );
    }
    return errorResponse(error, "Appointment request failed");
  }
}
