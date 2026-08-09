/**
 * POST /api/transcribe — Deepgram nova-3 multilingual transcription.
 *
 * Body:  raw audio bytes (Content-Type set to the recorder's mimetype)
 * 200:   { transcript, languages, duration, model }
 *
 * Exists as a server route so the billable `sl_live_` key never reaches the
 * browser. The Supafone SDK's `liveTranscribe()` puts the key in a WebSocket
 * query string, which would leak it to any client that opened DevTools.
 */

import { NextRequest } from "next/server";
import { transcribeMultilingual, SupafoneError } from "@/lib/server/supafone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous enough for ~10s of Opus, small enough to bound abuse. */
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json(
      { error: "SUPAFONE_LABS_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength === 0) {
    return Response.json({ error: "Empty audio body." }, { status: 400 });
  }
  if (body.byteLength > MAX_BYTES) {
    return Response.json(
      { error: `Clip too large (${body.byteLength} bytes; max ${MAX_BYTES}).` },
      { status: 413 },
    );
  }

  // Strip any codec parameters; Deepgram wants a plain container type.
  const mimetype = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();

  try {
    const result = await transcribeMultilingual(body, { mimetype });
    return Response.json(result);
  } catch (e) {
    if (e instanceof SupafoneError) {
      return Response.json({ error: e.message, detail: e.body?.slice(0, 300) }, { status: 502 });
    }
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
