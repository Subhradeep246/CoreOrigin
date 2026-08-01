import { getEnv } from "./runtime-env";
import { annotateProvidersWithInsurance } from "./insurance";
import type { ProviderResult } from "./validation";

const NIMBLE_BASE_URL = "https://sdk.nimbleway.com/v1";

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const candidate = string(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProvider(value: unknown): ProviderResult | null {
  const row = object(value);
  const info = object(row.place_information);
  const review = object(row.review_summary);
  const name = string(row.title);
  if (!name) return null;

  const categories = Array.isArray(row.business_category)
    ? row.business_category.map(string).filter((item): item is string => Boolean(item)).slice(0, 10)
    : [];
  const website = safeUrl(info.website_url);
  const sourceUrl = safeUrl(row.place_url) ?? website;
  const rating = number(review.overall_rating) ?? number(row.rating);
  const reviewCount = number(review.review_count) ?? number(row.number_of_reviews);

  return {
    id: string(row.place_id) ?? string(row.cid) ?? `provider-${crypto.randomUUID()}`,
    name,
    facilityName: categories[0],
    address:
      string(row.address) ??
      ([string(row.street_address), string(row.city), string(row.zip_code)]
        .filter(Boolean)
        .join(", ") || undefined),
    phone: string(row.phone_number),
    website,
    sourceUrl,
    rating: rating === undefined ? undefined : Math.min(5, Math.max(0, rating)),
    reviewCount: reviewCount === undefined ? undefined : Math.max(0, Math.round(reviewCount)),
    categories,
    availability: "unknown",
  };
}

async function nimbleFetch(path: string, body: UnknownRecord): Promise<unknown> {
  const apiKey = getEnv("NIMBLE_API_KEY");
  if (!apiKey) throw new Error("Provider search is not configured");

  const response = await fetch(`${NIMBLE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Provider search unavailable (${response.status})`);
  }
  return response.json();
}

export async function searchProviders(input: {
  location: string;
  specialty: string;
  insurance?: string;
}): Promise<{ providers: ProviderResult[]; searchedAt: string; source: string }> {
  const location = input.location.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const specialty = input.specialty.replace(/[^a-zA-Z\s,-]/g, "").trim().slice(0, 80);
  const payload = await nimbleFetch("/serp", {
    search_engine: "google_maps_search",
    query: `${specialty} doctors and clinics near ${location}`,
    country: "US",
    locale: "en",
    num_results: 8,
    no_html: true,
  });

  const response = object(payload);
  const parsing = Object.keys(object(response.parsing)).length
    ? object(response.parsing)
    : object(object(response.data).parsing);
  const rows = object(parsing.entities).SearchResult;
  const providers = annotateProvidersWithInsurance(
    (Array.isArray(rows) ? rows : [])
      .map(normalizeProvider)
      .filter((provider): provider is ProviderResult => provider !== null)
      .slice(0, 6),
    input.insurance,
  );

  return {
    providers,
    searchedAt: new Date().toISOString(),
    source: "Nimble Google Maps public listings",
  };
}

export async function searchMedicalSources(query: string): Promise<{
  sources: Array<{ title: string; description: string; url: string }>;
}> {
  const cleanQuery = query.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  const payload = object(
    await nimbleFetch("/search", {
      query: cleanQuery,
      focus: "general",
      country: "US",
      locale: "en-US",
      search_depth: "deep",
      max_results: 5,
      include_answer: false,
      include_domains: ["cdc.gov", "nih.gov", "medlineplus.gov", "who.int"],
    }),
  );

  const rows = Array.isArray(payload.results) ? payload.results : [];
  return {
    sources: rows
      .map((value) => {
        const row = object(value);
        const title = string(row.title);
        const url = safeUrl(row.url);
        if (!title || !url) return null;
        return {
          title,
          description: string(row.description)?.slice(0, 500) ?? "",
          url,
        };
      })
      .filter((source): source is { title: string; description: string; url: string } => source !== null),
  };
}
