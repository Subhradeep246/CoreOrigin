/**
 * One-Click Agent Factory — headless demo runner.
 *
 * Usage (loads .env.local for SUPAFONE_LABS_API_KEY):
 *   npm run factory -- --url https://a-business.example
 *   npm run factory -- --url https://a-business.example --voice
 *   npm run factory -- --url https://a-business.example --provision --area-code 415
 *   npm run factory -- --url https://a-business.example --phone +16464279105 --call
 *
 * Flags:
 *   --url <url>        (required) the company website to turn into an agent
 *   --provision        buy a managed number + create the hosted inbound agent
 *                      (needs a matching app.supafone.ai account: `npm run link`)
 *   --area-code <nnn>  preferred area code for the managed number
 *   --phone <e164>     phone number for the optional live call
 *   --call             place the live call (implies --provision, since the API
 *                      bridges an existing agent onto the line)
 *   --voice            render the greeting to public/agent-greeting.wav
 *   --no-qa            skip the adversarial QA suite (saves oracle minutes)
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { runFactory, type FactoryEvent } from "@/lib/server/agent-factory";
import { getBalance } from "@/lib/server/supafone";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const ICON: Record<string, string> = {
  scrape: "🔎",
  knowledge: "📚",
  graph: "🕸️ ",
  configure: "⚙️ ",
  objective: "🎯",
  qa: "🧪",
  voice: "🔊",
  provision: "☎️ ",
  call: "📞",
  complete: "✅",
  error: "❌",
};

async function main() {
  const url = arg("url");
  if (!url) {
    console.error("Missing --url. Example: npm run factory -- --url https://example.com");
    process.exit(1);
  }
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    console.error("SUPAFONE_LABS_API_KEY is not set. Run with: node --env-file=.env.local ...");
    process.exit(1);
  }

  const onEvent = (e: FactoryEvent) => {
    const icon = ICON[e.step] ?? "•";
    if (e.status === "start") console.log(`${icon} ${e.step}… ${e.detail ?? ""}`);
    else if (e.status === "skipped") console.log(`${icon} ${e.step}: skipped — ${e.detail ?? ""}`);
    else if (e.step !== "complete") console.log(`${icon} ${e.step} ✓ ${e.detail ?? ""}`);
  };

  console.log(`\n=== One-Click Agent Factory ===\nURL: ${url}\n`);

  const result = await runFactory({
    url,
    phone: arg("phone"),
    runQa: !flag("no-qa"),
    qaCount: arg("qa-count") ? Number(arg("qa-count")) : 3,
    qaTurns: arg("qa-turns") ? Number(arg("qa-turns")) : 2,
    makeVoiceSample: flag("voice"),
    provision: flag("provision"),
    areaCode: arg("area-code"),
    placeCall: flag("call"),
    onEvent,
  });

  console.log(`\n--- Agent ready: ${result.graph.business.name} (${result.agentLabel}) ---`);
  console.log(`Assistant: ${result.graph.assistant.name} · voice ${result.graph.assistant.voice}`);
  console.log(`Greeting : "${result.graph.assistant.greeting}"`);
  console.log(`Stages   : ${result.graph.stages.map((s) => s.name).join(" -> ")}`);
  console.log(`Tools    : ${result.graph.tools.map((t) => t.name).join(", ")}`);
  console.log(`Portal   : ${result.portalUrl}`);

  if (result.voiceSampleWavBase64) {
    const out = path.join(process.cwd(), "public", "agent-greeting.wav");
    writeFileSync(out, Buffer.from(result.voiceSampleWavBase64, "base64"));
    console.log(`Voice    : wrote ${out}`);
  }

  if (result.qa) {
    console.log(`\nQA suite :\n${JSON.stringify(result.qa, null, 2).slice(0, 1200)}`);
  }

  if (result.provision) {
    const p = result.provision;
    if (p.linked) {
      console.log(`\nProvisioned:`);
      console.log(`  agent id : ${p.agentId ?? "—"}`);
      console.log(`  number   : ${p.phoneNumber ?? "— (none returned)"}`);
      if (p.phoneNumber) console.log(`  ☎️  Call ${p.phoneNumber} to talk to the agent.`);
    } else {
      console.log(`\nProvisioning skipped — ${p.message}`);
      console.log(`  Fix with: npm run link -- --send    (then click the emailed link)`);
    }
  }

  if (result.call) {
    console.log(`\nCall     : ${result.call.ok ? "placed ✓" : "not placed"} — ${result.call.message}`);
  }

  try {
    const bal = (await getBalance()) as { minutes_remaining?: number };
    console.log(`\nMinutes remaining: ${bal.minutes_remaining ?? "?"}`);
  } catch {
    /* balance is best-effort */
  }

  console.log(`\nAgent prompt (${result.agentPrompt.length} chars):\n${result.agentPrompt}\n`);
}

main().catch((e) => {
  console.error("\n❌ Factory failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
