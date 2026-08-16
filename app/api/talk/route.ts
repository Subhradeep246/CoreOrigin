/**
 * POST /api/talk — start a free browser voice call with a provisioned agent.
 *
 * Body: { agentId: string }
 * 200:  { joinUrl, callId, maxDurationSeconds, freeCallsRemaining }
 *
 * The join URL is short-lived and scoped to one call, so it is safe to hand to
 * the browser; the Supafone API key never leaves the server.
 */

import { NextRequest } from "next/server";
import { deleteHostedAgent, listProductAgents, startBrowserCall } from "@/lib/server/supafone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/talk — the hosted agents available to call. */
export async function GET() {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json({ agents: [], error: "SUPAFONE_LABS_API_KEY is not configured." }, { status: 503 });
  }
  return Response.json({ agents: await listProductAgents() });
}

export async function POST(req: NextRequest) {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json(
      { error: "SUPAFONE_LABS_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let agentId = "";
  try {
    const body = (await req.json()) as { agentId?: string };
    agentId = (body.agentId ?? "").trim();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!agentId) {
    return Response.json(
      { error: "agentId is required — provision the agent first." },
      { status: 400 },
    );
  }

  const session = await startBrowserCall(agentId);
  if (!session.ok || !session.joinUrl) {
    return Response.json(
      { error: session.detail ?? `Could not start a browser call (HTTP ${session.status}).` },
      { status: session.status === 0 ? 502 : session.status },
    );
  }

  return Response.json({
    joinUrl: session.joinUrl,
    callId: session.callId,
    maxDurationSeconds: session.maxDurationSeconds,
    freeCallsRemaining: session.freeCallsRemaining,
  });
}

/**
 * DELETE /api/talk — free the trial's single hosted-agent slot.
 * Body: { agentId?: string, agentKey?: string }
 */
export async function DELETE(req: NextRequest) {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json(
      { error: "SUPAFONE_LABS_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let agentId = "";
  let agentKey = "";
  try {
    const body = (await req.json()) as { agentId?: string; agentKey?: string };
    agentId = (body.agentId ?? "").trim();
    agentKey = (body.agentKey ?? "").trim();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const target = agentKey || agentId;
  if (!target) {
    return Response.json({ error: "agentId or agentKey is required." }, { status: 400 });
  }

  const result = await deleteHostedAgent(target);
  return Response.json(
    { ok: result.ok, deleted: result.deleted, detail: result.detail },
    { status: result.ok ? 200 : result.status === 400 ? 400 : 502 },
  );
}
