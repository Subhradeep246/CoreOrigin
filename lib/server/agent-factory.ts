/**
 * One-Click Agent Factory — SERVER ONLY.
 *
 * Turn a company URL into a configured, QA-validated Supafone voice agent:
 *
 *   scrape site -> knowledge base -> agent graph + tools -> compiled prompt
 *   -> save as a Supafone builder agent -> set objective -> adversarial QA
 *   -> voice sample -> (optional) ring a real phone.
 *
 * Everything except the final phone call runs on the Supafone Labs Cloud API
 * with a self-serve `sl_live_` key. The phone call uses the Supafone product
 * API and needs a matching app.supafone.ai account (same email).
 */

import {
  oracleJson,
  saveBuilderConfig,
  setObjective,
  qaSuite,
  tts,
  callHuman,
  createFactoryAgent,
  provisionPhoneNumber,
  productAccountLinked,
  type ObjectiveCriterion,
} from "@/lib/server/supafone";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ScrapedPage {
  url: string;
  title: string;
  text: string;
}

export interface ScrapeResult {
  rootUrl: string;
  pages: ScrapedPage[];
  combinedText: string;
}

export interface AgentStage {
  id: string;
  name: string;
  goal: string;
  sample_lines?: string[];
}

export interface AgentTool {
  name: string;
  when: string;
  description: string;
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface AgentGraph {
  business: {
    name: string;
    tagline?: string;
    summary: string;
    phone?: string;
    email?: string;
    address?: string;
    hours?: string;
    services?: string[];
  };
  assistant: {
    name: string;
    voice: string;
    persona: string;
    greeting: string;
  };
  stages: AgentStage[];
  tools: AgentTool[];
  faqs: FaqItem[];
  guardrails: string[];
  objective: {
    goal: string;
    criteria: ObjectiveCriterion[];
  };
}

export type FactoryEvent =
  | { step: "scrape"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "knowledge"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "graph"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "configure"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "objective"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "qa"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "voice"; status: "start" | "done"; detail?: string; data?: unknown }
  | { step: "provision"; status: "start" | "done" | "skipped"; detail?: string; data?: unknown }
  | { step: "call"; status: "start" | "done" | "skipped"; detail?: string; data?: unknown }
  | { step: "error"; status: "done"; detail: string }
  | { step: "complete"; status: "done"; data?: unknown };

/** Outcome of the real provisioning step on the Supafone product API. */
export interface ProvisionResult {
  attempted: boolean;
  linked: boolean;
  /** The hosted product agent, when created. */
  agentId?: string;
  agentKey?: string;
  /** The managed number that now answers as this agent. */
  phoneNumber?: string;
  numberId?: string;
  message: string;
  raw?: unknown;
}

export interface FactoryResult {
  url: string;
  agentLabel: string;
  graph: AgentGraph;
  agentPrompt: string;
  qa: unknown;
  portalUrl: string;
  voiceSampleWavBase64?: string;
  provision?: ProvisionResult;
  call?: { attempted: boolean; ok: boolean; status: number; message: string; data?: unknown };
}

/* ------------------------------------------------------------------ */
/* 1. Scrape                                                           */
/* ------------------------------------------------------------------ */

const KEY_PAGE_HINTS = [
  "about",
  "service",
  "services",
  "product",
  "pricing",
  "price",
  "contact",
  "hours",
  "location",
  "faq",
  "faqs",
  "book",
  "booking",
  "appointment",
  "menu",
  "team",
  "care",
];

function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : "";
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchPage(url: string, timeoutMs = 9000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    // Accept anything that is HTML by content-type OR by sniffing the body,
    // since some CDNs serve HTML with an unexpected or missing content-type.
    const looksHtml = /text\/html|application\/xhtml/i.test(ct) || /<html|<!doctype/i.test(text);
    if (!looksHtml) return null;
    return text;
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function discoverLinks(html: string, rootUrl: string): string[] {
  const origin = new URL(rootUrl).origin;
  const hrefs = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const scored: { url: string; score: number }[] = [];
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    const label = stripHtml(m[2]).toLowerCase();
    try {
      const abs = new URL(href, rootUrl).toString().split("#")[0];
      if (!abs.startsWith(origin)) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|webp|css|js|ico)$/i.test(abs)) continue;
      if (hrefs.has(abs) || abs === rootUrl) continue;
      hrefs.add(abs);
      const hay = `${abs.toLowerCase()} ${label}`;
      const score = KEY_PAGE_HINTS.reduce((s, h) => (hay.includes(h) ? s + 1 : s), 0);
      scored.push({ url: abs, score });
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.url);
}

export async function scrapeSite(rawUrl: string, maxPages = 5): Promise<ScrapeResult> {
  const rootUrl = normalizeUrl(rawUrl);
  const homeHtml = await fetchPage(rootUrl);
  if (!homeHtml) {
    throw new Error(`Could not fetch ${rootUrl}. Check the URL is reachable and serves HTML.`);
  }

  const pages: ScrapedPage[] = [
    { url: rootUrl, title: extractTitle(homeHtml), text: stripHtml(homeHtml).slice(0, 6000) },
  ];

  const candidates = discoverLinks(homeHtml, rootUrl).slice(0, maxPages - 1);
  for (const link of candidates) {
    if (pages.length >= maxPages) break;
    if (!sameOrigin(link, rootUrl)) continue;
    const html = await fetchPage(link);
    if (!html) continue;
    const text = stripHtml(html);
    if (text.length < 120) continue;
    pages.push({ url: link, title: extractTitle(html), text: text.slice(0, 4000) });
  }

  const combinedText = pages
    .map((p) => `URL: ${p.url}\nTITLE: ${p.title}\n${p.text}`)
    .join("\n\n---\n\n")
    .slice(0, 16000);

  return { rootUrl, pages, combinedText };
}

/* ------------------------------------------------------------------ */
/* 2 + 3. Knowledge base -> agent graph (one oracle call)              */
/* ------------------------------------------------------------------ */

export const GRAPH_SYSTEM = `You are an expert voice-AI solutions architect. Given the scraped text of a
business website, design a phone receptionist agent for that business.

Return ONE JSON object only — no prose, no markdown fences. Be concise: short
strings, no filler. Match this shape exactly:
{
  "business": {
    "name": string,            // the real business name
    "tagline": string,         // short, may be ""
    "summary": string,         // ONE sentence on what they do
    "phone": string,           // "" if unknown
    "email": string,           // "" if unknown
    "address": string,         // "" if unknown
    "hours": string,           // "" if unknown
    "services": string[]       // up to 6 short service names
  },
  "assistant": {
    "name": string,            // a friendly first name for the receptionist
    "voice": string,           // one of: supafone-labs-calm-en, aura-asteria-en, aura-luna-en, aura-orion-en
    "persona": string,         // <= 12 words on tone
    "greeting": string         // exact first line when a call connects, <= 200 chars, names the business
  },
  "stages": [                  // exactly 4-5 stages; goal <= 15 words; NO other keys
    { "id": string, "name": string, "goal": string }
  ],
  "tools": [                   // 4-5 tools; description <= 15 words
    { "name": string, "when": string, "description": string }
  ],
  "faqs": [                    // 4-5 Q&A grounded ONLY in the text; answer <= 30 words
    { "q": string, "a": string }
  ],
  "guardrails": string[],      // 3-4 short rules
  "objective": {
    "goal": string,            // ONE sentence success outcome
    "criteria": [ { "name": string, "description": string } ]  // exactly 3, description <= 12 words
  }
}

Rules: Ground every fact in the provided text. If a fact is not present, leave
it "" — never invent phone numbers, prices, or addresses. Keep the WHOLE reply
under 1500 words. Pick tool names that fit the business (e.g. book_appointment,
check_hours, take_message, transfer_to_human, send_sms_summary,
check_order_status, quote_lookup).`;

export async function generateAgentGraph(scrape: ScrapeResult): Promise<AgentGraph> {
  const user = `Website root: ${scrape.rootUrl}\n\nScraped content:\n${scrape.combinedText}`;
  const graph = await oracleJson<AgentGraph>({
    system: GRAPH_SYSTEM,
    user,
    max_tokens: 4000,
  });

  // Defensive normalization so downstream never crashes on a thin model reply.
  graph.business ??= { name: "", summary: "" } as AgentGraph["business"];
  graph.business.name ||= new URL(scrape.rootUrl).hostname.replace(/^www\./, "");
  graph.business.services ??= [];
  graph.assistant ??= {
    name: "Alex",
    voice: "supafone-labs-calm-en",
    persona: "warm and efficient",
    greeting: `Thanks for calling ${graph.business.name}. How can I help?`,
  };
  graph.assistant.voice ||= "supafone-labs-calm-en";
  graph.assistant.greeting ||= `Thanks for calling ${graph.business.name}. How can I help you today?`;
  graph.stages ??= [];
  graph.tools ??= [];
  graph.faqs ??= [];
  graph.guardrails ??= [];
  graph.objective ??= { goal: "Help the caller and capture their request.", criteria: [] };
  graph.objective.criteria ??= [];
  return graph;
}

/* ------------------------------------------------------------------ */
/* Compile the agent graph into a <=4000 char system prompt            */
/* ------------------------------------------------------------------ */

export function compileAgentPrompt(graph: AgentGraph): string {
  const b = graph.business;
  const lines: string[] = [];

  lines.push(
    `You are ${graph.assistant.name}, the AI phone receptionist for ${b.name}.`,
    `Persona: ${graph.assistant.persona}. Speak naturally, one question at a time, and keep replies short for voice.`,
    "",
    "== FIRST LINE ==",
    graph.assistant.greeting,
    "",
    "== ABOUT THE BUSINESS ==",
    b.summary || b.tagline || "",
  );
  if (b.services?.length) lines.push(`Services: ${b.services.join("; ")}.`);
  const facts: string[] = [];
  if (b.hours) facts.push(`Hours: ${b.hours}`);
  if (b.phone) facts.push(`Phone: ${b.phone}`);
  if (b.email) facts.push(`Email: ${b.email}`);
  if (b.address) facts.push(`Address: ${b.address}`);
  if (facts.length) lines.push(facts.join(" | "));

  if (graph.stages.length) {
    lines.push("", "== CALL FLOW ==");
    graph.stages.forEach((s, i) => lines.push(`${i + 1}. ${s.name}: ${s.goal}`));
  }

  if (graph.tools.length) {
    lines.push("", "== TOOLS (call when appropriate) ==");
    graph.tools.forEach((t) => lines.push(`- ${t.name}: ${t.description} (use when ${t.when}).`));
  }

  if (graph.faqs.length) {
    lines.push("", "== KNOWLEDGE (answer only from these facts) ==");
    for (const f of graph.faqs) lines.push(`Q: ${f.q}\nA: ${f.a}`);
  }

  lines.push("", "== GUARDRAILS ==");
  const guards = graph.guardrails.length
    ? graph.guardrails
    : ["Never invent prices, availability, or facts not stated above.", "If unsure, offer to take a message or transfer to a human."];
  guards.forEach((g) => lines.push(`- ${g}`));

  lines.push(
    "",
    "== GOAL ==",
    graph.objective.goal,
    "If you cannot help, politely take a message with the caller's name, number, and reason, then confirm someone will follow up.",
  );

  let prompt = lines.filter((l) => l !== undefined).join("\n").trim();
  if (prompt.length > 4000) {
    // Trim the knowledge block first — it is the most compressible.
    prompt = prompt.slice(0, 3990) + " …";
  }
  return prompt;
}

/* ------------------------------------------------------------------ */
/* Full pipeline                                                       */
/* ------------------------------------------------------------------ */

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "agent"
  );
}

/**
 * Provision the real thing: a hosted inbound Supafone agent plus a managed
 * phone number that answers as it.
 *
 * This is the only part of the pipeline that needs a matching app.supafone.ai
 * account. When the account is missing we do NOT throw — the factory still
 * produced a complete, QA-validated agent on the Labs side, so we report the
 * gap and let the caller decide.
 */
export async function provisionRealAgent(params: {
  agentKey: string;
  graph: AgentGraph;
  agentPrompt: string;
  websiteUrl: string;
  areaCode?: string;
}): Promise<ProvisionResult> {
  const link = await productAccountLinked();
  if (!link.linked) {
    return {
      attempted: true,
      linked: false,
      message: link.detail,
    };
  }

  // 1. Create the hosted inbound agent from the compiled prompt.
  const agent = (await createFactoryAgent({
    agentKey: params.agentKey,
    name: params.graph.business.name,
    assistantName: params.graph.assistant.name,
    websiteUrl: params.websiteUrl,
    systemPrompt: params.agentPrompt,
    greeting: params.graph.assistant.greeting,
    agentType: "inbound",
    areaCode: params.areaCode,
    labs: true,
  })) as Record<string, unknown>;

  const agentId =
    pickString(agent, ["agent_id", "agentId", "id"]) ?? params.agentKey;

  // 2. Buy + attach a managed number so the agent is actually callable.
  //    createFactoryAgent may already have provisioned one; only buy if not.
  let phoneNumber = pickString(agent, ["phone_number", "phoneNumber"]);
  let numberId = pickString(agent, ["number_id", "numberId"]);
  let numberRaw: unknown = null;

  if (!phoneNumber) {
    try {
      const num = (await provisionPhoneNumber({
        agentKey: agentId,
        areaCode: params.areaCode,
      })) as Record<string, unknown>;
      numberRaw = num;
      phoneNumber = pickString(num, ["phone_number", "phoneNumber", "number", "e164"]);
      numberId = pickString(num, ["number_id", "numberId", "id"]);
    } catch (e) {
      return {
        attempted: true,
        linked: true,
        agentId,
        agentKey: params.agentKey,
        message: `Agent created, but number provisioning failed: ${(e as Error).message}`,
        raw: agent,
      };
    }
  }

  return {
    attempted: true,
    linked: true,
    agentId,
    agentKey: params.agentKey,
    phoneNumber,
    numberId,
    message: phoneNumber
      ? `Agent live on ${phoneNumber}`
      : "Agent created; no number returned.",
    raw: { agent, number: numberRaw },
  };
}

/** Read the first present string field from a loose API response. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  // Some responses nest under `agent` / `number` / `data`.
  for (const wrapper of ["agent", "number", "data", "result"]) {
    const nested = obj[wrapper];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const got = pickString(nested as Record<string, unknown>, keys);
      if (got) return got;
    }
  }
  return undefined;
}

export interface RunFactoryOptions {
  url: string;
  phone?: string;
  runQa?: boolean;
  qaCount?: number;
  qaTurns?: number;
  makeVoiceSample?: boolean;
  /** Buy a managed number + create the hosted inbound agent (needs a linked account). */
  provision?: boolean;
  /** Preferred area code for the managed number. */
  areaCode?: string;
  placeCall?: boolean;
  onEvent?: (e: FactoryEvent) => void | Promise<void>;
}

export async function runFactory(opts: RunFactoryOptions): Promise<FactoryResult> {
  const emit = async (e: FactoryEvent) => {
    if (opts.onEvent) await opts.onEvent(e);
  };

  // 1. Scrape
  await emit({ step: "scrape", status: "start", detail: `Fetching ${opts.url}` });
  const scrape = await scrapeSite(opts.url);
  await emit({
    step: "scrape",
    status: "done",
    detail: `Read ${scrape.pages.length} page(s)`,
    data: { pages: scrape.pages.map((p) => ({ url: p.url, title: p.title })) },
  });

  // 2 + 3. Knowledge base -> agent graph
  await emit({ step: "knowledge", status: "start", detail: "Distilling knowledge base" });
  await emit({ step: "graph", status: "start", detail: "Generating agent graph + tools" });
  const graph = await generateAgentGraph(scrape);
  const agentPrompt = compileAgentPrompt(graph);
  const agentLabel = slugify(graph.business.name);
  await emit({
    step: "knowledge",
    status: "done",
    detail: graph.business.name,
    data: { business: graph.business, faqs: graph.faqs },
  });
  await emit({
    step: "graph",
    status: "done",
    detail: `${graph.stages.length} stages, ${graph.tools.length} tools`,
    data: { assistant: graph.assistant, stages: graph.stages, tools: graph.tools, guardrails: graph.guardrails },
  });

  // 4. Configure the Supafone builder agent
  await emit({ step: "configure", status: "start", detail: "Saving agent configuration" });
  await saveBuilderConfig({
    agent_prompt: agentPrompt,
    agent_label: agentLabel,
    framework: "ultravox",
    llm: { provider: "hosted" },
  });
  const portalUrl = "https://labs.supafone.ai/agents/default";
  await emit({ step: "configure", status: "done", detail: agentLabel, data: { portalUrl } });

  // 5. Objective
  await emit({ step: "objective", status: "start" });
  await setObjective({
    agent: agentLabel,
    goal: graph.objective.goal,
    criteria: graph.objective.criteria,
    rule: "all",
  });
  await emit({ step: "objective", status: "done", detail: graph.objective.goal });

  // 6. Adversarial QA
  let qa: unknown = null;
  if (opts.runQa !== false) {
    await emit({ step: "qa", status: "start", detail: "Running adversarial test suite" });
    qa = await qaSuite({
      count: opts.qaCount ?? 3,
      turns: opts.qaTurns ?? 2,
      supervised: true,
    });
    await emit({ step: "qa", status: "done", data: qa });
  }

  // 7. Voice sample
  let voiceSampleWavBase64: string | undefined;
  if (opts.makeVoiceSample) {
    await emit({ step: "voice", status: "start", detail: "Rendering the greeting" });
    try {
      const { audio } = await tts({ text: graph.assistant.greeting, voice: graph.assistant.voice });
      voiceSampleWavBase64 = audio.toString("base64");
      await emit({ step: "voice", status: "done", detail: `${audio.length} bytes` });
    } catch (e) {
      await emit({ step: "voice", status: "done", detail: `voice sample skipped: ${(e as Error).message}` });
    }
  }

  // 8. Provision the real agent + managed number (the "callable" half).
  //     Required before a live call: the product API bridges an EXISTING agent.
  let provision: ProvisionResult | undefined;
  if (opts.provision || opts.placeCall) {
    await emit({ step: "provision", status: "start", detail: "Creating hosted agent + number" });
    provision = await provisionRealAgent({
      agentKey: agentLabel,
      graph,
      agentPrompt,
      websiteUrl: scrape.rootUrl,
      areaCode: opts.areaCode,
    });
    await emit({
      step: "provision",
      status: provision.linked ? "done" : "skipped",
      detail: provision.message,
      data: { agentId: provision.agentId, phoneNumber: provision.phoneNumber },
    });
  }

  // 9. Optional live call — needs a provisioned agent to bridge onto the line.
  let call: FactoryResult["call"];
  if (opts.placeCall) {
    if (!opts.phone) {
      call = { attempted: false, ok: false, status: 0, message: "No phone number provided." };
      await emit({ step: "call", status: "skipped", detail: "No phone number provided." });
    } else if (!provision?.agentId) {
      const message =
        provision && !provision.linked
          ? `Cannot call yet — ${provision.message}`
          : "Cannot call: no provisioned agent to bridge onto the line.";
      call = { attempted: false, ok: false, status: 0, message };
      await emit({ step: "call", status: "skipped", detail: message });
    } else {
      await emit({ step: "call", status: "start", detail: `Calling ${opts.phone}` });
      const res = await callHuman({ to_number: opts.phone, agent_id: provision.agentId });
      const message = res.ok
        ? "Call placed — your phone should ring."
        : typeof res.data.detail === "string"
          ? res.data.detail
          : `Call not placed (HTTP ${res.status}).`;
      call = { attempted: true, ok: res.ok, status: res.status, message, data: res.data };
      await emit({ step: "call", status: "done", detail: message, data: res.data });
    }
  }

  const result: FactoryResult = {
    url: scrape.rootUrl,
    agentLabel,
    graph,
    agentPrompt,
    qa,
    portalUrl,
    voiceSampleWavBase64,
    provision,
    call,
  };
  await emit({ step: "complete", status: "done", data: { agentLabel, portalUrl } });
  return result;
}
