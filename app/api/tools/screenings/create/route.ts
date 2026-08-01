import { authorizeToolRequest } from "@/lib/auth";

export async function POST(request: Request) {
  const auth = authorizeToolRequest(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return Response.json(
    {
      enabled: false,
      error: "Voice disease screening is disabled until a clinically validated screening service is configured.",
    },
    { status: 403 },
  );
}
