/**
 * Shared request hardening for every Voia API route.
 *
 * Privacy rules enforced here:
 *  - Every response is `no-store`. Nothing Voia returns may be cached by a
 *    browser, a CDN, or a proxy.
 *  - Errors are generic. A validation failure never echoes the submitted value,
 *    so a phone number, name, DOB, or code can never appear in an error body.
 *  - Rate limiting keys on a SHA-256 hash of the client IP, held in an ephemeral
 *    in-memory Map. No IP, phone number, or patient value is ever stored.
 *  - Nothing in this module logs. There is no database and no filesystem write.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { issueMessages } from "@/lib/shared/schemas";

/** Hard cap on request bodies. Voia's largest legitimate payload is tiny. */
export const MAX_BODY_BYTES = 32 * 1024;

const PRIVACY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** JSON response that may never be cached or sniffed. */
export function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(PRIVACY_HEADERS)) {
    headers.set(name, value);
  }
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Generic error response.
 *
 * `message` must be a fixed, product-authored string. Never interpolate a
 * submitted value, an upstream provider error, or an exception message.
 */
export function errorResponse(status: number, message: string): NextResponse {
  return jsonNoStore({ error: message }, { status });
}

export type ReadJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Parse and validate a JSON request body.
 *
 * Returns short, value-free issue messages on failure (the shared schemas are
 * authored so their messages never contain user input).
 */
export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ReadJsonResult<T>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, "Request body is too large.") };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, "Request body could not be read.") };
  }

  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, "Request body is too large.") };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonNoStore(
        { error: "Invalid request.", issues: ["The request body must be valid JSON."] },
        { status: 400 },
      ),
    };
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      response: jsonNoStore(
        { error: "Invalid request.", issues: issueMessages(result.error) },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: result.data };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Ephemeral sliding-window counters.
 *
 * Keys are opaque hashes; values are timestamps only. This Map is process-local
 * and lost on restart by design — it is not a store of anything about a person.
 */
const windows = new Map<string, number[]>();

/** Bound the Map so a burst of distinct hashes cannot grow it without limit. */
const MAX_TRACKED_KEYS = 5000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the caller may retry, 0 when allowed. */
  retryAfterMs: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [existingKey, stamps] of windows) {
      const live = stamps.filter((stamp) => stamp > cutoff);
      if (live.length === 0) windows.delete(existingKey);
      else windows.set(existingKey, live);
    }
    if (windows.size > MAX_TRACKED_KEYS) windows.clear();
  }

  const recent = (windows.get(key) ?? []).filter((stamp) => stamp > cutoff);

  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    windows.set(key, recent);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + windowMs - now),
    };
  }

  recent.push(now);
  windows.set(key, recent);
  return { allowed: true, remaining: Math.max(0, limit - recent.length), retryAfterMs: 0 };
}

/** Test/maintenance helper. Clears the ephemeral counters. */
export function resetRateLimits(): void {
  windows.clear();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Derive an opaque rate-limit key from the request's network origin.
 *
 * The raw IP is hashed immediately and never returned, stored, or logged.
 * `scope` lets a route keep its own bucket (e.g. "otp-request").
 */
export function clientKey(request: Request, scope = "global"): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
  const ip = first || request.headers.get("x-real-ip")?.trim() || "unknown";
  return `${scope}:${hash(ip)}`;
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which of `names` are missing or blank.
 *
 * Read lazily at call time so an unset secret never breaks a build, and only
 * the variable NAMES are ever surfaced — never their values.
 */
export function requireEnv(names: string[]): string[] {
  return names.filter((name) => {
    const value = process.env[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
}
