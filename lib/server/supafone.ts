/**
 * Supafone Labs Cloud API client — SERVER ONLY.
 *
 * One key (`sl_live_...`) fronts the whole voice-AI stack:
 *  - oracle/complete  hosted LLM (Claude / GPT / Grok, prefix-routed)
 *  - tts              managed voice rendering
 *  - builder/*        the hosted agent builder (prompt, framework, telephony)
 *  - agents           named agents that show up in the Labs portal
 *  - optimizer/*      objective + self-improving standing directive
 *  - qa/*             adversarial test suites with pass/fail + SSR grades
 *
 * Auth model (verified against the live API):
 *  - oracle / tts / stt / usage / billing / voices  -> Bearer <API key>
 *  - agents / builder / optimizer / qa / classify    -> Bearer <session token>
 *    (these reject the raw key with 401 "Log in first"; a session token is
 *    minted from the key via POST /v1/auth/key-login)
 *
 * The Agent Factory (real managed numbers) and the outbound "call a human"
 * endpoint live on the Supafone PRODUCT API (https://api.supafone.ai) and
 * require a matching app.supafone.ai account under the same email. The same
 * `sl_live_` key is accepted there once that account exists.
 */

const CLOUD_BASE = "https://api.labs.supafone.ai";
const PRODUCT_BASE = "https://api.supafone.ai";

export class SupafoneError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "SupafoneError";
    this.status = status;
    this.body = body;
  }
}

export interface OracleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OracleResult {
  text: string;
  model?: string;
  usage?: unknown;
}

export interface BuilderTelephony {
  provider?: string;
  account_sid?: string;
  auth_token?: string;
  from_number?: string;
}

export interface BuilderLLM {
  provider?: string;
  api_key?: string;
  model?: string;
}

export interface BuilderConfig {
  agent_prompt: string;
  agent_label?: string;
  framework?: string;
  framework_key?: string;
  telephony?: BuilderTelephony;
  llm?: BuilderLLM;
}

export interface ObjectiveCriterion {
  name: string;
  description?: string;
}

export interface ObjectiveRequest {
  agent?: string;
  goal: string;
  criteria?: ObjectiveCriterion[];
  rule?: "all" | "any" | string;
  ground_truth_weight?: number;
}

export interface QASuiteRequest {
  count?: number;
  turns?: number;
  supervised?: boolean;
}

type Json = Record<string, unknown>;

function apiKey(): string {
  const key = (process.env.SUPAFONE_LABS_API_KEY ?? "").trim();
  if (!key) {
    throw new SupafoneError(
      "SUPAFONE_LABS_API_KEY is not set on the server.",
      0,
      "",
    );
  }
  return key;
}

/** app.supafone.ai account the Labs key must be issued to. Matching is by email. */
export function expectedAccountEmail(): string {
  return (process.env.SUPAFONE_ACCOUNT_EMAIL ?? "sa9457@nyu.edu").trim().toLowerCase();
}

/** Cached session token (minted from the API key) for builder-family routes. */
let sessionToken: string | null = null;
let sessionTokenAt = 0;
const SESSION_TTL_MS = 20 * 60 * 1000;

async function sessionAuth(): Promise<string> {
  const fresh = sessionToken && Date.now() - sessionTokenAt < SESSION_TTL_MS;
  if (fresh && sessionToken) return sessionToken;
  const res = await fetch(`${CLOUD_BASE}/v1/auth/key-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: apiKey() }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SupafoneError("key-login failed", res.status, text);
  }
  const parsed = safeJson(text) as Json;
  const token =
    (parsed.token as string) ||
    (parsed.session_token as string) ||
    (parsed.access_token as string) ||
    "";
  if (!token) throw new SupafoneError("key-login returned no token", res.status, text);
  sessionToken = token;
  sessionTokenAt = Date.now();
  return token;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  auth: "key" | "session";
  base?: string;
  /** When true, return the raw Response (for binary audio). */
  raw?: boolean;
}

async function request<T = Json>(path: string, opts: RequestOpts): Promise<T> {
  const base = opts.base ?? CLOUD_BASE;
  const token = opts.auth === "session" ? await sessionAuth() : apiKey();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (opts.raw) return res as unknown as T;

  const text = await res.text();
  if (!res.ok) {
    throw new SupafoneError(`${opts.method ?? "GET"} ${path} -> ${res.status}`, res.status, text);
  }
  return safeJson(text) as T;
}

/* ------------------------------------------------------------------ */
/* Account / status                                                    */
/* ------------------------------------------------------------------ */

export function introspectKey(): Promise<Json> {
  return request("/v1/keys/introspect", { auth: "key" });
}

export function getUsage(): Promise<Json> {
  return request("/v1/usage", { auth: "key" });
}

export function getBalance(): Promise<Json> {
  return request("/v1/billing/balance", { auth: "key" });
}

export function getAccount(): Promise<Json> {
  return request("/v1/account", { auth: "session" });
}

export function listVoices(): Promise<Json> {
  return request("/v1/voices", { auth: "key" });
}

/* ------------------------------------------------------------------ */
/* Oracle (hosted LLM)                                                 */
/* ------------------------------------------------------------------ */

export async function oracleComplete(params: {
  messages: OracleMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
}): Promise<OracleResult> {
  const body: Json = {
    messages: params.messages,
    max_tokens: params.max_tokens ?? 1024,
  };
  if (params.model) body.model = params.model;
  if (typeof params.temperature === "number") body.temperature = params.temperature;

  const data = (await request("/v1/oracle/complete", {
    method: "POST",
    auth: "key",
    body,
  })) as Json;

  const text =
    (data.text as string) ??
    (data.completion as string) ??
    (data.output as string) ??
    "";
  return { text, model: data.model as string, usage: data.usage };
}

/**
 * Ask the oracle for a strict JSON object. Retries once with a repair nudge if
 * the first response is not parseable.
 */
export async function oracleJson<T = Json>(params: {
  system: string;
  user: string;
  model?: string;
  max_tokens?: number;
}): Promise<T> {
  const base: OracleMessage[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const first = await oracleComplete({
    messages: base,
    model: params.model,
    max_tokens: params.max_tokens ?? 1600,
    temperature: 0.3,
  });
  const parsed = extractJson<T>(first.text);
  if (parsed) return parsed;

  const repair = await oracleComplete({
    messages: [
      ...base,
      { role: "assistant", content: first.text.slice(0, 3000) },
      {
        role: "user",
        content:
          "That was not valid JSON. Reply with ONLY the JSON object, no prose, no markdown fences.",
      },
    ],
    model: params.model,
    max_tokens: params.max_tokens ?? 1600,
    temperature: 0,
  });
  const repaired = extractJson<T>(repair.text);
  if (repaired) return repaired;
  throw new SupafoneError("Oracle did not return parseable JSON.", 200, first.text.slice(0, 400));
}

/**
 * Extract a JSON object from arbitrary model text. Handles ```json fences,
 * trailing prose, and prefers the OUTERMOST object (so we never accidentally
 * return a small nested object when the outer one is present).
 */
export function extractJson<T = Json>(text: string): T | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (!s) return null;

  const tryParse = (c: string): T | null => {
    try {
      const v = JSON.parse(c);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
    } catch {
      return null;
    }
  };

  // 1. Prefer the contents of a fenced ```json ... ``` block.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    const fromFence = tryParse(inner) ?? extractOutermost(inner, tryParse);
    if (fromFence) return fromFence;
  }

  // 2. Strip any stray fences and try the whole string.
  s = s.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "").trim();
  const direct = tryParse(s);
  if (direct) return direct;

  // 3. Outermost balanced object (first "{" to its matching "}").
  const outer = extractOutermost(s, tryParse);
  if (outer) return outer;

  // 4. Last resort: the response was TRUNCATED (hit the output-token cap) so no
  //    balanced object exists. Salvage by closing the JSON at the last complete
  //    top-level property, then closing any still-open brackets/braces.
  return repairTruncatedJson<T>(s, tryParse);
}

function repairTruncatedJson<T>(s: string, tryParse: (c: string) => T | null): T | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  const body = s.slice(start);

  // Walk the string tracking structure. A "safe" cut point is only ever right
  // after a COMPLETE value: at a comma (depth>=1) or at a closing bracket. We
  // never cut after a bare key, so the salvaged text stays valid once closed.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastSafe = -1;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      lastSafe = i + 1; // just after a closed value
    } else if (ch === "," && depth >= 1) {
      lastSafe = i; // cut before the comma -> ends after a complete value
    }
  }

  if (lastSafe <= 0) return null;

  // Rebuild the still-open structure from the stack at lastSafe by re-walking.
  let candidate = body.slice(0, lastSafe).replace(/,\s*$/, "");
  // Recompute open brackets for the trimmed candidate.
  const open: string[] = [];
  let str = false;
  let e2 = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (str) {
      if (e2) e2 = false;
      else if (ch === "\\") e2 = true;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  if (str) candidate += '"';
  for (let i = open.length - 1; i >= 0; i -= 1) candidate += open[i] === "{" ? "}" : "]";

  return tryParse(candidate);
}

function extractOutermost<T>(s: string, tryParse: (c: string) => T | null): T | null {
  const start = s.indexOf("{");
  if (start === -1) return null;

  // Greedy: root "{" to the LAST "}" — handles trailing prose after the object.
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace > start) {
    const greedy = tryParse(s.slice(start, lastBrace + 1));
    if (greedy) return greedy;
  }

  // Balanced match from the ROOT "{" only. We deliberately do NOT fall back to
  // inner objects: if the root does not close, the reply was truncated and
  // repairTruncatedJson should salvage it instead of returning a child object.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return tryParse(s.slice(start, i + 1));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* TTS                                                                 */
/* ------------------------------------------------------------------ */

export async function tts(params: {
  text: string;
  voice?: string;
  format?: "wav" | "mp3" | string;
}): Promise<{ audio: Buffer; contentType: string }> {
  const res = (await request("/v1/tts", {
    method: "POST",
    auth: "key",
    raw: true,
    body: {
      text: params.text.slice(0, 1000),
      voice: params.voice ?? "supafone-labs-calm-en",
      format: params.format ?? "wav",
    },
  })) as Response;
  const contentType = res.headers.get("content-type") ?? "audio/wav";
  if (!res.ok) {
    const t = await res.text();
    throw new SupafoneError(`tts -> ${res.status}`, res.status, t);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { audio: buf, contentType };
}

/* ------------------------------------------------------------------ */
/* Self-healing watcher (the "second mind")                            */
/* ------------------------------------------------------------------ */

/**
 * Supafone Labs' own coaching-core system prompt, matched to the SDK so our
 * directives read the same as theirs. The empty-string contract matters: a
 * quiet oracle means "the agent is doing fine", and we inject nothing.
 */
const COACH_SYSTEM =
  "You are the coaching core of a second mind for a live voice agent. Read the " +
  "conversation and return ONE short, silent directive the agent reads but never " +
  "speaks aloud — a correction or nudge, phrased imperatively. If nothing needs " +
  "correcting, return an empty string.";

export interface WhisperResult {
  /** The directive, or "" when the agent needs no correction. */
  directive: string;
  model?: string;
}

/**
 * Ask the watcher whether the live call needs a silent correction.
 *
 * Runs off the call's latency path: a slow or failed oracle simply yields no
 * directive and the conversation proceeds untouched. Kept short (120 tokens)
 * because a directive the agent must read mid-call has to be one line.
 */
export async function whisperDirective(params: {
  transcript: string;
  guardrails?: string;
  objective?: string;
  /** BCP-47 tags from nova-3 (or the scraped language profile). Directives follow the caller. */
  languages?: string[];
}): Promise<WhisperResult> {
  const langs = (params.languages ?? []).map((l) => l.trim()).filter(Boolean);
  const liveLang = langs.filter((l) => !/^en(-|$)/i.test(l));
  const rules = [
    params.objective ? `Call objective:\n${params.objective}` : "",
    params.guardrails ? `Operator rules:\n${params.guardrails}` : "",
    langs.length
      ? `Detected caller languages: ${langs.join(", ")}. Write the directive in the caller's current language.`
      : "",
    liveLang.length
      ? "The caller is not in English — do not coach in English unless they switched back."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const system = rules ? `${COACH_SYSTEM}\n\n${rules}` : COACH_SYSTEM;

  const out = await oracleComplete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: params.transcript },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });

  return { directive: sanitizeDirective(out.text ?? ""), model: out.model };
}

/**
 * Normalise an oracle directive into one clean imperative line.
 *
 * Observed in practice: the model wraps the directive in code fences
 * (```` ``\nGreet warmly.\n`` ````), adds quotes, or narrates that no action is
 * needed. Injecting any of that verbatim would push backticks and newlines into
 * the live agent's context, so it is stripped here, and "no correction needed"
 * phrasings collapse to silence.
 *
 * Exported for tests — this is exactly the kind of string munging that breaks
 * quietly.
 */
export function sanitizeDirective(raw: string): string {
  let d = (raw ?? "").trim();

  // Fenced block, with or without a language tag.
  const fenced = d.match(/^`{2,}[a-zA-Z]*\s*([\s\S]*?)\s*`{2,}$/);
  if (fenced) d = fenced[1].trim();

  // Leftover backticks or wrapping quotes.
  d = d.replace(/^`+|`+$/g, "").trim();
  d = d.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();

  // A directive is read mid-call: collapse to a single line.
  d = d.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();

  // Explicit "nothing to fix" answers mean stay quiet.
  if (/^(none|n\/?a|no correction(s)? needed|nothing|no change(s)?|ok|fine)\.?$/i.test(d)) return "";

  return d;
}

/**
 * File a whisper into the Labs audit feed. Zero-billed, and best-effort: the
 * watcher must never fail a call because logging failed.
 */
export async function reportNudge(event: {
  text: string;
  confidence?: number;
  injected: boolean;
  session_id?: string;
  agent?: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${CLOUD_BASE}/v1/events/nudge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* STT — Deepgram nova-3 multilingual                                  */
/* ------------------------------------------------------------------ */

export interface MultilingualTranscript {
  transcript: string;
  /** BCP-47-ish tags nova-3 detected, e.g. ["es"] or ["en","es"] when code-switching. */
  languages: string[];
  /** Billed audio seconds. */
  duration: number;
  model: string;
}

/**
 * Transcribe an audio clip with Deepgram nova-3 in multilingual mode.
 *
 * `language=multi` is nova-3's code-switching mode: it detects the language per
 * word across en/es/fr/de/hi/ru/pt/ja/it/nl and tags every utterance, so a
 * caller who switches mid-sentence still transcribes correctly.
 *
 * Note this is Supafone's PRERECORDED endpoint. The streaming socket that the
 * SDK and docs describe (`WS /v1/stt/live`) returns 404 on the deployed gateway
 * and is absent from its OpenAPI schema, so live streaming is not available —
 * callers feed short self-contained clips instead.
 *
 * Billing: charged by audio duration against the Labs minute balance.
 */
export async function transcribeMultilingual(
  audio: Uint8Array | Buffer,
  opts: { mimetype?: string; language?: string } = {},
): Promise<MultilingualTranscript> {
  const url = `${CLOUD_BASE}/v1/stt?language=${encodeURIComponent(opts.language ?? "multi")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": opts.mimetype ?? "application/octet-stream",
    },
    body: new Uint8Array(audio),
  });
  const text = await res.text();
  if (!res.ok) throw new SupafoneError(`stt -> ${res.status}`, res.status, text);

  const data = safeJson(text) as Json;
  // Flattened shape when present; otherwise dig into the raw Deepgram envelope.
  const raw = (data.raw ?? data) as Json;
  const alt = (
    ((raw.results as Json)?.channels as Json[] | undefined)?.[0]?.alternatives as Json[] | undefined
  )?.[0];
  const meta = (raw.metadata ?? {}) as Json;
  const modelInfo = (meta.model_info ?? {}) as Record<string, { name?: string; arch?: string }>;
  const firstModel = Object.values(modelInfo)[0];

  return {
    transcript: String(data.transcript ?? alt?.transcript ?? ""),
    languages: (data.languages as string[]) ?? (alt?.languages as string[]) ?? [],
    duration: Number(data.duration ?? meta.duration ?? 0),
    model: firstModel?.arch ?? firstModel?.name ?? "nova-3",
  };
}

/* ------------------------------------------------------------------ */
/* Builder / agents                                                    */
/* ------------------------------------------------------------------ */

export function listAgents(): Promise<Json> {
  return request("/v1/agents", { auth: "session" });
}

export function createAgent(params: { label: string; framework?: string }): Promise<Json> {
  return request("/v1/agents", {
    method: "POST",
    auth: "session",
    body: { label: params.label.slice(0, 60), framework: params.framework ?? "ultravox" },
  });
}

export function getBuilderConfig(): Promise<Json> {
  return request("/v1/builder/config", { auth: "session" });
}

export function saveBuilderConfig(config: BuilderConfig): Promise<Json> {
  return request("/v1/builder/config", {
    method: "POST",
    auth: "session",
    body: {
      agent_prompt: config.agent_prompt.slice(0, 4000),
      agent_label: (config.agent_label ?? "builder").slice(0, 60),
      framework: config.framework ?? "ultravox",
      framework_key: config.framework_key ?? "",
      telephony: {
        provider: config.telephony?.provider ?? "twilio",
        account_sid: config.telephony?.account_sid ?? "",
        auth_token: config.telephony?.auth_token ?? "",
        from_number: config.telephony?.from_number ?? "",
      },
      llm: {
        provider: config.llm?.provider ?? "hosted",
        api_key: config.llm?.api_key ?? "",
        model: config.llm?.model ?? "",
      },
    },
  });
}

export function updateAgent(agentId: string, config: BuilderConfig): Promise<Json> {
  return request(`/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    auth: "session",
    body: config,
  });
}

/* ------------------------------------------------------------------ */
/* Optimizer / QA                                                      */
/* ------------------------------------------------------------------ */

export function setObjective(req: ObjectiveRequest): Promise<Json> {
  return request("/v1/optimizer/objective", {
    method: "POST",
    auth: "session",
    body: {
      agent: req.agent ?? "builder",
      goal: req.goal.slice(0, 1000),
      criteria: req.criteria ?? [],
      rule: req.rule ?? "all",
      ground_truth_weight: req.ground_truth_weight ?? 0.5,
    },
  });
}

export function qaSuite(req: QASuiteRequest = {}): Promise<Json> {
  return request("/v1/qa/suite", {
    method: "POST",
    auth: "session",
    body: {
      count: req.count ?? 4,
      turns: req.turns ?? 2,
      supervised: req.supervised ?? false,
    },
  });
}

export function qaGenerate(params: { agent_prompt: string; count?: number }): Promise<Json> {
  return request("/v1/qa/generate", {
    method: "POST",
    auth: "session",
    body: { agent_prompt: params.agent_prompt.slice(0, 4000), count: params.count ?? 5 },
  });
}

export function builderChat(params: {
  messages: { role: string; text: string }[];
  session_id?: string;
  agent_id?: string;
}): Promise<Json> {
  return request("/v1/builder/chat", {
    method: "POST",
    auth: "session",
    body: {
      messages: params.messages,
      session_id: params.session_id ?? "builder",
      agent_id: params.agent_id ?? "default",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Live phone (Supafone PRODUCT API — needs app.supafone.ai account)   */
/* ------------------------------------------------------------------ */

export function testerCapabilities(): Promise<Json> {
  return request("/v1/tester/capabilities", { auth: "key" });
}

/**
 * Is the Labs key "matched" to a Supafone product account yet?
 *
 * The product API maps a bearer `sl_` key to an app.supafone.ai account BY
 * EMAIL. Until an account exists under the key's email, every product route
 * (managed numbers, live calls) answers 401 with an explanatory detail.
 */
export async function productAccountLinked(): Promise<{
  linked: boolean;
  status: number;
  detail: string;
}> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/labs/capabilities`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  const text = await res.text();
  const data = safeJson(text) as Json;
  return {
    linked: res.ok,
    status: res.status,
    detail: typeof data.detail === "string" ? data.detail : res.ok ? "linked" : text.slice(0, 200),
  };
}

/** Which sign-in methods the product API currently offers. */
export async function productAuthConfig(): Promise<Json> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/auth/config`);
  return safeJson(await res.text()) as Json;
}

/**
 * Create the matching Supafone PRODUCT account directly — the instant fix.
 *
 * This is exactly what the Labs console's own "Finish account setup" panel
 * does (`ensureProductAccount` in console.html): a plain signup on the product
 * API with the Labs key's email. Because the product API maps `sl_` keys to
 * accounts BY EMAIL, creating this account is what "matches" the key.
 *
 * HTTP 409 means the account already exists, which is success for our purpose.
 * Unlike the magic link, nothing has to be clicked in an inbox.
 */
export async function ensureProductAccount(params: {
  email: string;
  password: string;
  fullName?: string;
}): Promise<{ ok: boolean; created: boolean; status: number; detail: string }> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: params.email,
      password: params.password,
      full_name: params.fullName ?? "",
    }),
  });
  const text = await res.text();
  const data = safeJson(text) as Json;
  const detail = typeof data.detail === "string" ? data.detail : text.slice(0, 200);
  if (res.ok) return { ok: true, created: true, status: res.status, detail: detail || "created" };
  if (res.status === 409) {
    return { ok: true, created: false, status: 409, detail: detail || "account already exists" };
  }
  return { ok: false, created: false, status: res.status, detail };
}

/**
 * Email a passwordless sign-in link. The product account is auto-created when
 * the recipient clicks it — which is exactly what "matching" requires. No
 * password is chosen or stored by us.
 */
export async function sendMagicLink(email: string, returnTo?: string): Promise<{
  ok: boolean;
  status: number;
  data: Json;
}> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, ...(returnTo ? { return_to: returnTo } : {}) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: safeJson(text) as Json };
}

/* ------------------------------------------------------------------ */
/* Agent Factory — real provisioning on the Supafone PRODUCT API       */
/*                                                                     */
/* Base: https://api.supafone.ai/api/v1/labs                            */
/* Auth: the SAME sl_live_ key, once a matching product account exists. */
/* ------------------------------------------------------------------ */

const FACTORY_BASE = `${PRODUCT_BASE}/api/v1/labs`;

async function factory<T = Json>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey()}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${FACTORY_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SupafoneError(`${opts.method ?? "GET"} labs${path} -> ${res.status}`, res.status, text);
  }
  return safeJson(text) as T;
}

/** The provisioning contract: accepted agent fields, runtimes, presets, voices. */
export function factoryCapabilities(): Promise<Json> {
  return factory("/capabilities");
}

/** Search buyable managed numbers. */
export function searchPhoneNumbers(params: {
  areaCode?: string;
  country?: string;
  limit?: number;
} = {}): Promise<Json> {
  return factory("/phone-numbers/search", {
    method: "POST",
    body: {
      ...(params.areaCode ? { area_code: params.areaCode, areaCode: params.areaCode } : {}),
      country: params.country ?? "US",
      limit: params.limit ?? 5,
    },
  });
}

export function listFactoryPhoneNumbers(): Promise<Json> {
  return factory("/phone-numbers");
}

/**
 * Buy a managed number and attach it to an agent. Real Twilio purchase on the
 * Supafone side (their docs note a simulated fallback without Twilio creds).
 */
export function provisionPhoneNumber(params: {
  agentKey: string;
  areaCode?: string;
  country?: string;
}): Promise<Json> {
  return factory("/phone-numbers", {
    method: "POST",
    body: {
      agent_key: params.agentKey,
      agentKey: params.agentKey,
      country: params.country ?? "US",
      ...(params.areaCode ? { area_code: params.areaCode, areaCode: params.areaCode } : {}),
    },
  });
}

export function listFactoryAgents(): Promise<Json> {
  return factory("/agents");
}

export function getFactoryAgent(agentKey: string): Promise<Json> {
  return factory(`/agents/${encodeURIComponent(agentKey)}`);
}

/**
 * Create a hosted inbound Supafone agent — the "launch a working voice agent"
 * half of the factory. `websiteUrl` lets Supafone do its own scrape-first
 * onboarding in addition to the knowledge we compiled.
 */
export function createFactoryAgent(params: {
  agentKey: string;
  name: string;
  assistantName?: string;
  websiteUrl?: string;
  systemPrompt?: string;
  greeting?: string;
  agentType?: "inbound" | "outbound" | "web";
  industry?: string;
  voice?: string;
  areaCode?: string;
  labs?: boolean;
  /** Voice Watcher / SecondMind (SDK 0.4.6+). Default on. */
  voiceWatcher?: boolean;
  voiceWatcherModel?: string;
  /** Up to four approved language profiles for mid-call switching. */
  languages?: string[];
}): Promise<Json> {
  const watcherOn = params.voiceWatcher ?? params.labs ?? true;
  const watcherModel = params.voiceWatcherModel ?? "gemma";
  return factory("/agents", {
    method: "POST",
    body: {
      agent_key: params.agentKey,
      agentKey: params.agentKey,
      name: params.name,
      agent_type: params.agentType ?? "inbound",
      agentType: params.agentType ?? "inbound",
      ...(params.assistantName
        ? { assistant_name: params.assistantName, assistantName: params.assistantName }
        : {}),
      ...(params.websiteUrl ? { website_url: params.websiteUrl, websiteUrl: params.websiteUrl } : {}),
      ...(params.systemPrompt
        ? { system_prompt: params.systemPrompt, systemPrompt: params.systemPrompt }
        : {}),
      ...(params.greeting ? { greeting: params.greeting, begin_message: params.greeting } : {}),
      ...(params.industry ? { industry: params.industry } : {}),
      ...(params.voice ? { voice: params.voice } : {}),
      ...(params.languages?.length ? { languages: params.languages.slice(0, 4) } : {}),
      ...(params.areaCode
        ? { number: { search: { area_code: params.areaCode, areaCode: params.areaCode } } }
        : {}),
      // New Voice Watcher flag (and labs alias) — see labs.supafone.ai/docs
      voice_watcher: watcherOn,
      voiceWatcher: watcherOn,
      voice_watcher_model: watcherModel,
      labs: { enabled: watcherOn, model: watcherModel },
    },
  });
}

/**
 * Place a REAL outbound call from an owned Supafone agent to a human phone.
 *
 * This hits the Supafone PRODUCT API. It only works once an app.supafone.ai
 * account exists under the same email as this Labs key. Until then it returns
 * a 401 whose body explains what to create. We surface that verbatim.
 */
export async function callHuman(params: {
  to_number: string;
  /**
   * The product agent to bridge onto the line. Per the product API's
   * TestCallRequest this is REQUIRED — the call dials the caller and bridges
   * them into an agent that already exists, so the agent must be provisioned
   * first (see createFactoryAgent).
   */
  agent_id: string;
}): Promise<{ ok: boolean; status: number; data: Json }> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/phone/test-call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: params.agent_id,
      to_number: params.to_number,
    }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: safeJson(text) as Json };
}

export interface ProductAgentSummary {
  id: string;
  name: string;
  assistantName: string;
  businessName: string;
  phoneNumber: string | null;
  /** Operator rules the watcher should enforce (from the agent's do-not-say list). */
  guardrails: string;
  /** What a successful call looks like, for the watcher to steer toward. */
  objective: string;
}

/** `do_not_say` comes back as a string on some agents and a list on others. */
function joinRules(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).join("; ");
  return typeof value === "string" ? value : "";
}

/** List the hosted agents on the linked product account. */
export async function listProductAgents(): Promise<ProductAgentSummary[]> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/agents`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) return [];
  const data = safeJson(await res.text()) as Json;
  const raw = Array.isArray(data) ? data : ((data.agents ?? data.items ?? []) as Json[]);
  return raw
    .map((a) => ({
      id: String(a.id ?? a.agent_id ?? ""),
      name: String(a.name ?? a.agent_key ?? "Untitled agent"),
      assistantName: String(a.assistant_name ?? "the assistant"),
      businessName: String(a.business_name ?? a.name ?? ""),
      phoneNumber: (a.phone_number as string) ?? null,
      guardrails: joinRules(a.do_not_say),
      objective: String((a.labs as Json | undefined)?.goal ?? ""),
    }))
    .filter((a) => a.id);
}

export interface BrowserCallSession {
  ok: boolean;
  status: number;
  /** WebRTC join URL (wss://voice.ultravox.ai/calls/...) for the browser SDK. */
  joinUrl?: string;
  callId?: string;
  maxDurationSeconds?: number;
  freeCallsRemaining?: number;
  detail?: string;
}

/**
 * Start a FREE browser (WebRTC) voice call with a provisioned product agent.
 *
 * This is the one live-voice path that needs no telephony at all: Supafone's
 * managed Twilio is currently disabled and we own no numbers, but this returns
 * an Ultravox join URL the browser can talk to directly (mic + speaker + live
 * transcripts). Documented as free but rate-limited (5/min).
 */
export async function startBrowserCall(agentId: string): Promise<BrowserCallSession> {
  const res = await fetch(
    `${PRODUCT_BASE}/api/v1/agents/${encodeURIComponent(agentId)}/test-call`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` } },
  );
  const text = await res.text();
  const data = safeJson(text) as Json;
  const browser = (data.browser_session ?? {}) as Json;
  return {
    ok: res.ok,
    status: res.status,
    joinUrl: (data.join_url as string) ?? (browser.join_url as string),
    callId: (data.call_id as string) ?? undefined,
    maxDurationSeconds: (data.max_duration_seconds as number) ?? undefined,
    freeCallsRemaining: (data.free_calls_remaining as number) ?? undefined,
    detail: typeof data.detail === "string" ? data.detail : undefined,
  };
}

/**
 * Zero-account fallback that proves telephony end to end.
 *
 * `POST /api/v1/public/demo/phone-call` is unauthenticated. Its request schema
 * carries ONLY a phone number, so it rings with Supafone's own generic demo
 * agent — it cannot carry our compiled prompt. Useful to show a real ringing
 * phone before an account exists; not a substitute for the real agent.
 */
export async function demoPhoneCall(phoneNumber: string): Promise<{
  ok: boolean;
  status: number;
  data: Json;
}> {
  const res = await fetch(`${PRODUCT_BASE}/api/v1/public/demo/phone-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number: phoneNumber }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: safeJson(text) as Json };
}
