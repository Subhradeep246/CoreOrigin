import { safeEqual } from "./crypto";
import { getEnv } from "./runtime-env";

export function authorizeToolRequest(request: Request): {
  ok: boolean;
  status: number;
  error?: string;
} {
  const expected = getEnv("VOIA_TOOL_SECRET");
  if (!expected) {
    return { ok: false, status: 503, error: "Agent tool authentication is not configured" };
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const supplied = request.headers.get("x-voia-tool-secret") ?? bearer ?? "";
  if (!safeEqual(expected, supplied)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true, status: 200 };
}
