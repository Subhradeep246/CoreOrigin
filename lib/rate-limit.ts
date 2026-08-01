import { eq } from "drizzle-orm";
import { getReadyDb } from "@/db";
import { memoryEnforceRateLimit } from "@/db/memory";
import { rateLimits } from "@/db/schema";
import { usesMemoryStorage } from "@/db/runtime";
import { sha256 } from "./crypto";

export class RateLimitError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super("Rate limit exceeded");
    this.retryAfter = retryAfter;
  }
}

export async function enforceRateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "local";
  const key = await sha256(`${bucket}|${ip.split(",")[0]?.trim()}`);
  const now = Math.floor(Date.now() / 1000);
  const resetBefore = now - windowSeconds;

  if (usesMemoryStorage()) {
    const result = await memoryEnforceRateLimit(key, limit, windowSeconds);
    if (!result.allowed) throw new RateLimitError(result.retryAfter);
    return;
  }

  const db = await getReadyDb();
  const [existing] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (!existing || existing.windowStartedAt <= resetBefore) {
    await db
      .insert(rateLimits)
      .values({ key, count: 1, windowStartedAt: now })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { count: 1, windowStartedAt: now },
      });
  } else {
    await db
      .update(rateLimits)
      .set({ count: existing.count + 1 })
      .where(eq(rateLimits.key, key));
  }

  const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (row && row.count > limit) {
    throw new RateLimitError(Math.max(1, row.windowStartedAt + windowSeconds - now));
  }
}

export function rateLimitResponse(error: RateLimitError): Response {
  return Response.json(
    { error: "Too many requests. Please wait and try again." },
    { status: 429, headers: { "retry-after": String(error.retryAfter) } },
  );
}
