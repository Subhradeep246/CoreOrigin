/**
 * Ring a real phone — the zero-account telephony proof.
 *
 *   npm run ring -- --phone +16464279105
 *
 * This uses Supafone's PUBLIC demo endpoint
 * (`POST /api/v1/public/demo/phone-call`), which needs no API key and no
 * account. Be clear about what it does and does not prove:
 *
 *   ✅ a real PSTN call reaches your handset, and a voice agent talks
 *   ❌ it is NOT the agent this factory built — the endpoint's request schema
 *      carries only a phone number, so it cannot accept our compiled prompt
 *
 * For the real thing (your generated agent answering its own managed number)
 * link the account first: `npm run link -- --send`, then
 * `npm run factory -- --url <site> --provision`.
 */

import { callHuman, demoPhoneCall } from "@/lib/server/supafone";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const phone = arg("phone");
  const agentId = arg("agent");
  if (!phone) {
    console.error("Usage:");
    console.error("  npm run ring -- --phone +1XXXXXXXXXX --agent <agent_id>   (your agent)");
    console.error("  npm run ring -- --phone +1XXXXXXXXXX                     (public demo agent)");
    process.exit(1);
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    console.error(`"${phone}" is not E.164. Example: +16464279105`);
    process.exit(1);
  }

  if (agentId) {
    console.log(`\n📞 Calling ${phone} and bridging in YOUR agent ${agentId} …\n`);
    const res = await callHuman({ to_number: phone, agent_id: agentId });
    console.log(`HTTP ${res.status}`);
    console.log(JSON.stringify(res.data, null, 2).slice(0, 1500));
    console.log(
      res.ok
        ? "\n✅ Carrier accepted. Your phone should ring in a few seconds."
        : "\n❌ Not placed — see the detail above.",
    );
    return;
  }

  console.log(`\n📞 Asking Supafone's public demo agent to call ${phone} …`);
  console.log("   (real call; generic demo agent, not your generated one)\n");
  const res = await demoPhoneCall(phone);
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2).slice(0, 1200));
  console.log(
    res.ok
      ? "\n✅ Requested. Your phone should ring within a few seconds."
      : "\n❌ Not placed. The demo endpoint may be rate-limited or disabled.",
  );
}

main().catch((e) => {
  console.error("\nFailed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
