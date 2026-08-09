/**
 * Regression tests for the One-Click Agent Factory's PURE logic.
 *
 * These run fully offline — no API key, no network, no billed minutes.
 *
 * Why these specific cases: the factory shipped broken once because the hosted
 * oracle caps output tokens, so a large agent-graph reply arrived TRUNCATED
 * mid-JSON. The extractor then silently returned the first nested object
 * (`business`) instead of the root, and every downstream field came back empty
 * (0 stages, 0 tools). Both behaviours are pinned below.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, sanitizeDirective } from "@/lib/server/supafone";
import { compileAgentPrompt, type AgentGraph } from "@/lib/server/agent-factory";

/* ------------------------------------------------------------------ */
/* extractJson                                                         */
/* ------------------------------------------------------------------ */

test("extractJson parses a bare object", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("extractJson unwraps a ```json fenced block", () => {
  const text = 'Here you go:\n```json\n{"business":{"name":"Acme"},"stages":[1,2]}\n```\nHope that helps!';
  assert.deepEqual(extractJson(text), { business: { name: "Acme" }, stages: [1, 2] });
});

test("extractJson unwraps an unlabelled fence", () => {
  assert.deepEqual(extractJson('```\n{"ok":true}\n```'), { ok: true });
});

test("extractJson ignores prose trailing the object", () => {
  assert.deepEqual(extractJson('{"a":1}\n\nLet me know if you need changes.'), { a: 1 });
});

test("extractJson returns the ROOT object, never a nested child", () => {
  // The exact shape that used to break the factory.
  const text = '{"business":{"name":"Basecamp"},"assistant":{"name":"Casey"},"stages":[{"id":"greet"}]}';
  const got = extractJson<Record<string, unknown>>(text);
  assert.ok(got);
  assert.deepEqual(Object.keys(got).sort(), ["assistant", "business", "stages"]);
});

test("extractJson repairs a TRUNCATED reply and still yields the root keys", () => {
  // Output-token cap hit: no closing brace, no closing fence, cut mid-value.
  const truncated = `\`\`\`json
{
  "business": { "name": "Basecamp", "services": ["PM", "Chat"] },
  "assistant": { "name": "Casey", "greeting": "Hi there!" },
  "stages": [
    { "id": "greet", "name": "Welcome", "goal": "Say hi" },
    { "id": "qualify", "name": "Qualify", "goal": "Find the need" }
  ],
  "tools": [
    { "name": "check_pricing", "when": "asked about cost", "descrip`;

  const got = extractJson<{
    business?: { name?: string };
    assistant?: { name?: string };
    stages?: unknown[];
  }>(truncated);

  assert.ok(got, "truncated JSON should still be salvaged");
  // Critically: the ROOT, not the inner `business` object.
  assert.equal(got.business?.name, "Basecamp");
  assert.equal(got.assistant?.name, "Casey");
  assert.equal(got.stages?.length, 2, "complete stages survive the repair");
});

test("extractJson tolerates braces inside string values", () => {
  const got = extractJson<{ greeting: string }>('{"greeting":"Use {braces} freely"}');
  assert.equal(got?.greeting, "Use {braces} freely");
});

test("extractJson tolerates escaped quotes inside strings", () => {
  const got = extractJson<{ q: string }>('{"q":"she said \\"hi\\" then left"}');
  assert.equal(got?.q, 'she said "hi" then left');
});

test("extractJson rejects non-objects and junk", () => {
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("no json at all"), null);
  assert.equal(extractJson("[1,2,3]"), null, "a bare array is not an agent graph");
  assert.equal(extractJson(123 as unknown as string), null);
});

/* ------------------------------------------------------------------ */
/* compileAgentPrompt                                                  */
/* ------------------------------------------------------------------ */

function graph(over: Partial<AgentGraph> = {}): AgentGraph {
  return {
    business: {
      name: "Northline Dental",
      summary: "A family dental practice.",
      services: ["Cleanings", "Whitening"],
      hours: "Mon-Fri 9-5",
      phone: "",
      email: "hi@northline.example",
      address: "",
      tagline: "",
    },
    assistant: {
      name: "Maya",
      voice: "supafone-labs-calm-en",
      persona: "warm and efficient",
      greeting: "Thanks for calling Northline Dental, this is Maya.",
    },
    stages: [{ id: "greet", name: "Welcome", goal: "Greet and find intent" }],
    tools: [{ name: "book_appointment", when: "caller wants a visit", description: "Book a slot" }],
    faqs: [{ q: "Do you take walk-ins?", a: "Yes, before 3pm." }],
    guardrails: ["Never quote prices not listed."],
    objective: { goal: "Book the caller.", criteria: [{ name: "Booked", description: "Slot taken" }] },
    ...over,
  } as AgentGraph;
}

test("compileAgentPrompt includes identity, greeting, tools, knowledge and goal", () => {
  const p = compileAgentPrompt(graph());
  assert.match(p, /You are Maya, the AI phone receptionist for Northline Dental\./);
  assert.match(p, /Thanks for calling Northline Dental, this is Maya\./);
  assert.match(p, /book_appointment/);
  assert.match(p, /Do you take walk-ins\?/);
  assert.match(p, /Never quote prices not listed\./);
  assert.match(p, /Book the caller\./);
  assert.match(p, /Cleanings; Whitening/);
});

test("compileAgentPrompt omits blank contact fields instead of printing empties", () => {
  const p = compileAgentPrompt(graph());
  assert.ok(!/Phone:\s*\|/.test(p), "empty phone must not be emitted");
  assert.ok(!/Address:/.test(p), "empty address must not be emitted");
  assert.match(p, /Email: hi@northline\.example/);
});

test("compileAgentPrompt supplies default guardrails when the model gave none", () => {
  const p = compileAgentPrompt(graph({ guardrails: [] }));
  assert.match(p, /Never invent prices, availability, or facts/);
});

test("compileAgentPrompt stays within the builder's 4000-char limit", () => {
  const huge = graph({
    faqs: Array.from({ length: 60 }, (_, i) => ({
      q: `Question number ${i} that is quite long indeed?`,
      a: "A deliberately verbose answer ".repeat(12),
    })),
  });
  const p = compileAgentPrompt(huge);
  assert.ok(p.length <= 4000, `prompt was ${p.length} chars; builder rejects >4000`);
});

/* ------------------------------------------------------------------ */
/* sanitizeDirective — the self-healing watcher's output                */
/* ------------------------------------------------------------------ */

/**
 * The watcher injects its directive straight into a LIVE call. The oracle was
 * observed returning ``` ``\nGreet warmly and ask how you can help.\n`` ```
 * — fence characters and newlines that would otherwise land verbatim in the
 * agent's context mid-conversation.
 */

test("sanitizeDirective strips the double-backtick fence seen in practice", () => {
  assert.equal(
    sanitizeDirective("``\nGreet warmly and ask how you can help.\n``"),
    "Greet warmly and ask how you can help.",
  );
});

test("sanitizeDirective strips triple-backtick fences with a language tag", () => {
  assert.equal(sanitizeDirective("```text\nSlow down, she sounds upset.\n```"), "Slow down, she sounds upset.");
});

test("sanitizeDirective strips wrapping quotes", () => {
  assert.equal(sanitizeDirective('"Do not quote a fee."'), "Do not quote a fee.");
  assert.equal(sanitizeDirective("'Acknowledge the injury first.'"), "Acknowledge the injury first.");
});

test("sanitizeDirective collapses a multi-line directive to one line", () => {
  assert.equal(
    sanitizeDirective("Stop.\nThe booking failed —\n  do not say it succeeded."),
    "Stop. The booking failed — do not say it succeeded.",
  );
});

test("sanitizeDirective treats an empty reply as silence", () => {
  assert.equal(sanitizeDirective(""), "");
  assert.equal(sanitizeDirective("   \n  "), "");
});

test("sanitizeDirective treats no-correction-needed phrasings as silence", () => {
  for (const quiet of ["none", "None.", "N/A", "nothing", "no corrections needed", "OK", "fine"]) {
    assert.equal(sanitizeDirective(quiet), "", `expected silence for ${JSON.stringify(quiet)}`);
  }
});

test("sanitizeDirective leaves a clean directive untouched", () => {
  const clean = "Ask for the caller's callback number before ending the call.";
  assert.equal(sanitizeDirective(clean), clean);
});

test("sanitizeDirective does not mistake a directive containing 'none' for silence", () => {
  const d = "Tell her none of the plans include phone support.";
  assert.equal(sanitizeDirective(d), d);
});
