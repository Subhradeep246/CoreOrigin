import { errorResponse } from "@/lib/http";
import { searchProviders } from "@/lib/nimble";
import { enforceRateLimit, RateLimitError, rateLimitResponse } from "@/lib/rate-limit";
import { providerSearchSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "provider-search", 12, 60);
    const input = providerSearchSchema.parse(await request.json());
    const result = await searchProviders(input);
    return Response.json({
      ...result,
      notice: input.insurance
        ? "Listings are ranked by a demo insurance fit estimate. Confirm network status with the office."
        : "Listings come from public sources. Add insurance to see likely network fit.",
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const response = errorResponse(error, "Provider search is unavailable right now");
    return new Response(response.body, { status: response.status === 500 ? 503 : response.status, headers: response.headers });
  }
}
