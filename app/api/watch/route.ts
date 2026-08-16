/**
 * POST /api/watch — the self-healing watcher's coaching turn.
 *
 * Body: { transcript, guardrails?, objective?, sessionId?, agent?, languages? }
 * 200:  { directive, injected, model }
 *
 * `directive` is "" when the agent needs no correction, which is the common
 * case — the caller should inject nothing rather than inventing filler.
 *
 * Runs server-side so the Supafone key stays off the client, and so a stalled
 * oracle degrades to silence instead of stalling the live call.
 */

import { NextRequest } from "next/server";
import { whisperDirective, reportNudge, SupafoneError } from "@/lib/server/supafone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bound the transcript we ship per turn; the tail is what matters for coaching. */
const MAX_TRANSCRIPT = 6000;

export async function POST(req: NextRequest) {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json(
      { error: "SUPAFONE_LABS_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let body: {
    transcript?: string;
    guardrails?: string;
    objective?: string;
    sessionId?: string;
    agent?: string;
    languages?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const transcript = (body.transcript ?? "").trim();
  if (!transcript) {
    return Response.json({ error: "transcript is required." }, { status: 400 });
  }

  try {
    const { directive, model } = await whisperDirective({
      // Keep the most recent turns — coaching is about the live moment.
      transcript: transcript.slice(-MAX_TRANSCRIPT),
      guardrails: body.guardrails,
      objective: body.objective,
      languages: Array.isArray(body.languages) ? body.languages.slice(0, 4) : undefined,
    });

    if (directive) {
      // Audit trail; zero-billed and non-blocking for the response contract.
      void reportNudge({
        text: directive,
        injected: true,
        session_id: body.sessionId,
        agent: body.agent,
      });
    }

    return Response.json({ directive, injected: Boolean(directive), model });
  } catch (e) {
    // Degrade-safe: the watcher going quiet must never break the call.
    if (e instanceof SupafoneError) {
      return Response.json(
        { directive: "", injected: false, error: e.message, detail: e.body?.slice(0, 200) },
        { status: 200 },
      );
    }
    return Response.json(
      { directive: "", injected: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
