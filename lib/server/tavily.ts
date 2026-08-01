/**
 * Tavily public-provider discovery — SERVER ONLY.
 *
 * What leaves the device for a search is deliberately tiny: a broad specialty,
 * a coarse location, and an optional non-sensitive provider preference. That is
 * already guaranteed by the STRICT `ProviderSearchSchema`; `sanitizeSearchTerm`
 * is defence-in-depth so a phone number, member id, or email can never reach a
 * third-party search API even if an upstream caller regresses.
 *
 * !! UNTRUSTED OUTPUT !!
 * Every string returned by this module originates from the public web. Results
 * are data, never instructions: they must never be forwarded to a model as
 * directions, executed, rendered as HTML, or treated as verified fact.
 * Availability, insurance acceptance, and credentials are NOT verified here.
 *
 * Nothing is logged, cached, or persisted.
 */

import { createHash } from "node:crypto";
import type { ProviderSearchInput } from "@/lib/shared/schemas";
import type { ProviderResult } from "@/lib/shared/types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 6;

const MAX_TERM_LENGTH = 80;
const MAX_NAME_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 160;
const MAX_PHONE_LENGTH = 24;
const MAX_URL_LENGTH = 300;

function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function tavilyConfigError(): string | null {
  if (!env("TAVILY_API_KEY")) {
    return "Provider search is not configured on this server (missing TAVILY_API_KEY).";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Outbound sanitisation                                               */
/* ------------------------------------------------------------------ */

/**
 * Strip anything identifier-shaped from a search term.
 *
 * Removes: email addresses, `+` phone prefixes, runs of 4 or more digits
 * (phone / member id / MRN / postal shapes), control characters, and any
 * punctuation outside a small safe set. Collapses whitespace and caps length.
 *
 * Exported for unit testing.
 */
export function sanitizeSearchTerm(value: string): string {
  if (typeof value !== "string") return "";

  return value
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // email addresses
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, " ")
    .replace(/@/g, " ")
    // international phone prefixes
    .replace(/\+\s*\d+/g, " ")
    .replace(/\+/g, " ")
    // any run of 4+ digits, including separated groups
    .replace(/(?:\d[\s().-]?){4,}/g, " ")
    // keep letters (incl. accented), digits, spaces and a small safe set
    .replace(/[^\p{L}\p{N}\s'&./-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH)
    .trim();
}

/**
 * Build the public search query from ONLY specialty, location, and preference.
 *
 * e.g. `"primary care clinics in Boston MA official hospital site"`.
 * Exported for unit testing.
 */
export function buildProviderQuery(input: ProviderSearchInput): string {
  const specialty = sanitizeSearchTerm(input.specialty);
  const location = sanitizeSearchTerm(input.location);
  const preference = sanitizeSearchTerm(input.providerPreference ?? "");

  const subject = [specialty, "clinics"].filter(Boolean).join(" ").trim();
  const parts = [preference, subject].filter(Boolean);
  const who = parts.join(" ").trim();

  const query = [who, location ? `in ${location}` : "", "official hospital site"]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return query;
}

/* ------------------------------------------------------------------ */
/* Inbound sanitisation (untrusted public web content)                 */
/* ------------------------------------------------------------------ */

/** Remove control chars, HTML, and markdown decoration; cap length. */
function cleanUntrusted(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]{2,8};/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~|<>{}\\^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Trim the site-name tail search engines append to titles. */
function cleanProviderName(title: unknown): string {
  const cleaned = cleanUntrusted(title, MAX_NAME_LENGTH * 2);
  if (!cleaned) return "";
  const head = cleaned.split(/\s+[-–—|:]\s+/)[0] ?? cleaned;
  const chosen = head.length >= 4 ? head : cleaned;
  return chosen.slice(0, MAX_NAME_LENGTH).trim();
}

function safeHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

const PHONE_PATTERN =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const ADDRESS_PATTERN =
  /\d{1,6}\s+[\p{L}0-9'.\- ]{2,40}\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|parkway|pkwy|suite|ste)\b[\p{L}0-9,'.\- ]{0,60}/iu;

function extractPhone(text: string): string | undefined {
  const match = PHONE_PATTERN.exec(text);
  if (!match) return undefined;
  const value = match[0].replace(/\s+/g, " ").trim().slice(0, MAX_PHONE_LENGTH);
  return value || undefined;
}

function extractAddress(text: string): string | undefined {
  const match = ADDRESS_PATTERN.exec(text);
  if (!match) return undefined;
  const value = match[0].replace(/\s+/g, " ").trim().slice(0, MAX_ADDRESS_LENGTH);
  return value || undefined;
}

function stableId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

type RawTavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Search public sources for clinics matching a broad specialty and area.
 *
 * Sends only the built query. No patient field of any kind is transmitted or
 * logged. Returns an empty array on any configuration, transport, or parsing
 * problem — the caller shows a generic "no results" state.
 */
export async function searchPublicProviders(
  input: ProviderSearchInput,
): Promise<ProviderResult[]> {
  if (tavilyConfigError() !== null) return [];

  const apiKey = env("TAVILY_API_KEY");
  const query = buildProviderQuery(input);
  if (!query) return [];

  let payload: unknown;
  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Newer Tavily deployments expect bearer auth; `api_key` in the body
        // remains supported, so both are provided.
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
      }),
      cache: "no-store",
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return [];
    payload = await response.json();
  } catch {
    // Silent by design: an upstream error body must never be logged.
    return [];
  }

  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];

  const seenHosts = new Set<string>();
  const providers: ProviderResult[] = [];

  for (const entry of payload.results as unknown[]) {
    if (providers.length >= MAX_RESULTS) break;
    if (!isRecord(entry)) continue;

    const raw = entry as RawTavilyResult;
    const url = typeof raw.url === "string" ? raw.url.trim().slice(0, MAX_URL_LENGTH) : "";
    if (!url) continue;

    const hostname = safeHostname(url);
    if (!hostname || seenHosts.has(hostname)) continue;

    const name = cleanProviderName(raw.title) || hostname;
    const content = cleanUntrusted(raw.content, 1200);

    seenHosts.add(hostname);
    providers.push({
      id: stableId(url),
      name,
      address: extractAddress(content),
      phone: extractPhone(content),
      website: `https://${hostname}`,
      sourceUrl: url,
      sourceLabel: hostname,
    });
  }

  return providers;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
