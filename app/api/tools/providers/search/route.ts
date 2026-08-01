import { authorizeToolRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { searchProviders } from "@/lib/nimble";
import { providerSearchSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const auth = authorizeToolRequest(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const input = providerSearchSchema.parse(await request.json());
    const result = await searchProviders(input);
    return Response.json({
      ...result,
      availability: "unknown",
      instruction: input.insurance
        ? "Present at most four options. Prefer likely_accepts listings first and say insurance fit is a demo estimate."
        : "Present at most four options. Never say a slot is available or booked.",
    });
  } catch (error) {
    return errorResponse(error, "Provider search failed");
  }
}
