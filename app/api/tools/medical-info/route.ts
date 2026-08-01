import { z } from "zod";
import { authorizeToolRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { searchMedicalSources } from "@/lib/nimble";

const schema = z.object({ query: z.string().trim().min(5).max(300) });

export async function POST(request: Request) {
  const auth = authorizeToolRequest(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const { query } = schema.parse(await request.json());
    const result = await searchMedicalSources(query);
    return Response.json({
      ...result,
      instruction: "Use for general education only. Do not diagnose or provide treatment instructions.",
    });
  } catch (error) {
    return errorResponse(error, "Medical source search failed");
  }
}
