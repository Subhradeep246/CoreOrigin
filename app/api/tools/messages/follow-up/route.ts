import { authorizeToolRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { sendCareFollowUpMessage } from "@/lib/messages";
import { followUpMessageSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const auth = authorizeToolRequest(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const input = followUpMessageSchema.parse({
      ...payload,
      source: "agent_tool",
    });
    return Response.json({ followUp: await sendCareFollowUpMessage(input) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Follow-up message failed");
  }
}
