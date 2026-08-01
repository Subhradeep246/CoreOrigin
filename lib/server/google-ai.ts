/**
 * Google AI Studio bridge — SERVER ONLY.
 *
 * The hosted model does exactly one job: phrase an approved booking question in
 * the patient's language. It is never a source of truth.
 *
 * Privacy guarantees enforced here:
 *  - The ONLY payload sent upstream is `JSON.stringify(input)`, where `input`
 *    has already passed the STRICT `AssistantRespondSchema`. It contains no
 *    name, phone, email, DOB, address, insurance identifier, free-text health
 *    concern, transcript, or audio.
 *  - Nothing is logged. Not the prompt, not the response, not the error body.
 *    No transcript is retained; there is no store of any kind.
 *  - Any unusable response returns `null` so the caller falls back to the
 *    deterministic local question set.
 *  - The model may never move the flow outside `input.allowedNextSteps`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  AssistantModelResponseSchema,
  type AssistantModelResponse,
  type AssistantRespondInput,
} from "@/lib/shared/schemas";

const PROMPT_RELATIVE_PATH = ["config", "google-booking-agent-prompt.md"] as const;
const REQUEST_TIMEOUT_MS = 10_000;

/** Config-only cache. Holds the product's own system instruction, never patient data. */
let cachedSystemInstruction: string | null = null;

function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Why the hosted assistant cannot run, or `null` when it can.
 *
 * Free/unpaid mode is a hard block: patient conversations must not be routed
 * through a tier whose data-handling terms allow training or human review.
 */
export function googleAiConfigError(): string | null {
  if (!env("GEMINI_API_KEY")) {
    return "The AI assistant is not configured on this server (missing GEMINI_API_KEY).";
  }
  if (!env("GOOGLE_AI_MODEL")) {
    return "The AI assistant is not configured on this server (missing GOOGLE_AI_MODEL).";
  }
  if (env("GOOGLE_AI_MODE") !== "paid") {
    return "Hosted AI assistance is disabled because GOOGLE_AI_MODE is not \"paid\". Voia will use its built-in questions instead.";
  }
  return null;
}

async function loadSystemInstruction(): Promise<string> {
  if (cachedSystemInstruction !== null) return cachedSystemInstruction;
  const filePath = path.join(process.cwd(), ...PROMPT_RELATIVE_PATH);
  const contents = await readFile(filePath, "utf8");
  const trimmed = contents.trim();
  if (!trimmed) throw new Error("EMPTY_SYSTEM_INSTRUCTION");
  cachedSystemInstruction = trimmed;
  return cachedSystemInstruction;
}

/* ------------------------------------------------------------------ */
/* Tolerant JSON extraction                                            */
/* ------------------------------------------------------------------ */

/**
 * Pull the first complete JSON object out of arbitrary model text.
 *
 * Necessary because the configured model may be a Gemma model, which ignores
 * `responseMimeType: "application/json"` and can return code fences, prose, or
 * chain-of-thought around the object.
 *
 * Exported for unit testing. Returns `null` when no object can be parsed.
 */
export function extractJsonObject(text: string): unknown | null {
  if (typeof text !== "string") return null;

  let working = text.trim();
  if (!working) return null;

  // Strip ``` / ```json fences wherever they appear.
  working = working
    .replace(/```[a-zA-Z0-9_-]*\s*/g, "")
    .replace(/```/g, "")
    .trim();

  // Fast path: the whole thing is already an object.
  const direct = tryParseObject(working);
  if (direct !== null) return direct;

  // Scan for the first balanced {...}, ignoring braces inside string literals.
  for (let start = working.indexOf("{"); start !== -1; start = working.indexOf("{", start + 1)) {
    const end = findMatchingBrace(working, start);
    if (end === -1) continue;
    const candidate = tryParseObject(working.slice(start, end + 1));
    if (candidate !== null) return candidate;
  }

  return null;
}

function tryParseObject(candidate: string): unknown | null {
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function findMatchingBrace(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/* ------------------------------------------------------------------ */
/* Model call                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ask the hosted model to phrase the next approved question.
 *
 * Returns `null` on any configuration problem, transport error, timeout,
 * malformed output, or out-of-bounds `nextStep`. The caller must then use the
 * deterministic fallback from `lib/shared/booking-state`.
 */
export async function requestBookingTurn(
  input: AssistantRespondInput,
): Promise<AssistantModelResponse | null> {
  if (googleAiConfigError() !== null) return null;

  try {
    const apiKey = env("GEMINI_API_KEY");
    const model = env("GOOGLE_AI_MODEL");
    const systemInstruction = await loadSystemInstruction();

    // The entire user payload. Nothing is appended, merged, or interpolated.
    const userContent = JSON.stringify(input);

    // Native JSON mode is honoured by Gemini models only. Gemma models ignore it
    // (and reject a system role), so their instruction rides as a leading part.
    const isGemini = model.toLowerCase().startsWith("gemini");

    const ai = new GoogleGenAI({ apiKey });

    const call = ai.models.generateContent({
      model,
      contents: isGemini
        ? [{ role: "user", parts: [{ text: userContent }] }]
        : [{ role: "user", parts: [{ text: systemInstruction }, { text: userContent }] }],
      config: {
        ...(isGemini
          ? { systemInstruction, responseMimeType: "application/json" }
          : {}),
        temperature: 0.2,
        maxOutputTokens: 600,
        abortSignal: timeoutSignal(REQUEST_TIMEOUT_MS),
      },
    });

    // Belt-and-braces: not every transport path honours abortSignal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS + 500);
    });

    let response: Awaited<typeof call> | null;
    try {
      response = await Promise.race([call, guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!response) return null;

    const text = response.text;
    if (typeof text !== "string" || !text.trim()) return null;

    const extracted = extractJsonObject(text);
    if (extracted === null) return null;

    const parsed = AssistantModelResponseSchema.safeParse(extracted);
    if (!parsed.success) return null;

    // Hard boundary: the model can never jump to a step the state machine
    // did not authorise for this turn.
    if (!input.allowedNextSteps.includes(parsed.data.nextStep)) return null;

    return parsed.data;
  } catch {
    // Deliberately silent: an error body could contain echoed request content.
    return null;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
