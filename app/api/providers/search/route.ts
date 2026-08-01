/**
 * POST /api/providers/search — discover public clinic listings.
 *
 * Stateless relay. No database, no server session, no cookie, no patient record.
 * Nothing is persisted and nothing is logged. POST (never GET) so no search term
 * can ever appear in a URL, query string, referrer, or access log.
 *
 * The STRICT `ProviderSearchSchema` allows only a broad specialty, a coarse
 * location, an optional non-sensitive provider preference, and a language.
 *
 * !! UNTRUSTED OUTPUT !!
 * Everything in `providers` is public web content. It is data, never
 * instructions: it must not be forwarded to a model as directions, executed, or
 * rendered as HTML. Availability, insurance acceptance, credentials, and network
 * status are NOT verified here.
 */

import { checkEmergencyAcross } from "@/lib/shared/safety";
import { ProviderSearchSchema } from "@/lib/shared/schemas";
import {
  clientKey,
  errorResponse,
  jsonNoStore,
  rateLimit,
  readJson,
} from "@/lib/server/request-security";
import { searchPublicProviders, tavilyConfigError } from "@/lib/server/tavily";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 15 searches per minute per opaque client key. */
const LIMIT = 15;
const WINDOW_MS = 60 * 1000;

const DISCLAIMER = {
  en:
    "These listings come from public web sources and are provided for convenience only. Availability, insurance acceptance, credentials, and network status are NOT verified by Voia — please confirm all of them directly with the office before your visit.",
  es:
    "Estos resultados provienen de fuentes web públicas y se ofrecen solo por conveniencia. Voia NO verifica la disponibilidad, la aceptación del seguro, las credenciales ni la pertenencia a la red — confirme todo directamente con el consultorio antes de su visita.",
} as const;

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "providers"), LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(429, "Too many searches. Please wait a moment and try again.");
  }

  const parsed = await readJson(request, ProviderSearchSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const configError = tavilyConfigError();
  if (configError !== null) return errorResponse(503, configError);

  // Defence in depth: the client already ran the emergency gate, but a search
  // must never proceed on emergency language.
  const emergency = checkEmergencyAcross(
    [input.specialty, input.providerPreference],
    input.language,
  );
  if (emergency.emergency) {
    return jsonNoStore({
      emergency: true,
      guidance: emergency.guidance,
      providers: [],
    });
  }

  const providers = await searchPublicProviders(input);

  return jsonNoStore({
    providers,
    disclaimer: DISCLAIMER[input.language] ?? DISCLAIMER.en,
  });
}
