/**
 * POST /api/factory — the One-Click Agent Factory endpoint.
 *
 * Body: { url: string, phone?: string, call?: boolean, voice?: boolean, qa?: boolean }
 *
 * Streams newline-delimited JSON (NDJSON) progress events as the pipeline runs,
 * so the UI can show live progress. The final event is:
 *   { step: "result", status: "done", data: FactoryResult }
 */

import { NextRequest } from "next/server";
import { runFactory, type FactoryEvent } from "@/lib/server/agent-factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface FactoryBody {
  url?: string;
  phone?: string;
  call?: boolean;
  voice?: boolean;
  qa?: boolean;
  provision?: boolean;
  areaCode?: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    return Response.json(
      { error: "SUPAFONE_LABS_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let body: FactoryBody;
  try {
    body = (await req.json()) as FactoryBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  if (!url) {
    return Response.json({ error: "A company URL is required." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      const onEvent = (e: FactoryEvent) => {
        write(e);
      };

      try {
        const result = await runFactory({
          url,
          phone: body.phone?.trim() || undefined,
          runQa: body.qa !== false,
          qaCount: 3,
          qaTurns: 2,
          makeVoiceSample: body.voice === true,
          provision: body.provision === true,
          areaCode: body.areaCode?.trim() || undefined,
          placeCall: body.call === true,
          onEvent,
        });
        write({ step: "result", status: "done", data: result });
      } catch (e) {
        write({ step: "error", status: "done", detail: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
