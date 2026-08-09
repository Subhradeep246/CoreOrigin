/**
 * Match the Labs key to a Supafone product account.
 *
 * The Labs key (`sl_live_...`) already works on the Labs Cloud API. The product
 * API (managed numbers + real outbound calls) maps that key to an
 * app.supafone.ai account BY EMAIL — so it stays 401 until an account exists
 * under the same email.
 *
 * Usage:
 *   npm run link                     # report current status
 *   npm run link -- --create         # create the account NOW (auto password)
 *   npm run link -- --create --password 'my-own-password'
 *   npm run link -- --send           # slower alternative: email a magic link
 *
 * `--create` mirrors what the Labs console's own "Finish account setup" panel
 * does: a signup on the product API with this key's email. Instant — nothing to
 * click in an inbox.
 */

import { randomBytes } from "node:crypto";
import {
  introspectKey,
  productAccountLinked,
  productAuthConfig,
  ensureProductAccount,
  sendMagicLink,
} from "@/lib/server/supafone";

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

/** Strong, URL-safe, satisfies the API's 8-char minimum with room to spare. */
function generatePassword(): string {
  return `Sf-${randomBytes(18).toString("base64url")}`;
}

async function status(): Promise<boolean> {
  const link = await productAccountLinked();
  if (link.linked) {
    console.log("✅ Matched — the Labs key now works on the Supafone product API.");
    console.log("   Managed numbers and live outbound calls are unlocked.");
  } else {
    console.log(`❌ Not matched yet (HTTP ${link.status}).`);
    console.log(`   ${link.detail}`);
  }
  return link.linked;
}

async function main() {
  if (!process.env.SUPAFONE_LABS_API_KEY) {
    console.error("SUPAFONE_LABS_API_KEY is not set (expected in .env.local).");
    process.exit(1);
  }

  const who = (await introspectKey()) as { email?: string; plan?: string; active?: boolean };
  const email = who.email ?? "";
  console.log(`\nLabs key owner : ${email}`);
  console.log(`Plan / active  : ${who.plan} / ${who.active}\n`);

  if (await status()) return;
  if (!email) {
    console.error("\nThe key did not report an email; cannot link automatically.");
    process.exit(1);
  }

  /* ---------- instant path: create the product account ---------- */
  if (flag("create")) {
    const supplied = arg("password");
    const password = supplied ?? generatePassword();

    console.log(`\n🔗 Creating the matching product account for ${email} …`);
    const res = await ensureProductAccount({ email, password });

    if (!res.ok) {
      console.error(`   ❌ Failed (HTTP ${res.status}): ${res.detail}`);
      console.error("   Try --send for the magic-link route, or sign in with Google.");
      process.exit(1);
    }

    console.log(
      res.created
        ? "   ✓ Account created."
        : "   ✓ Account already existed (that's fine — nothing to do).",
    );

    if (res.created && !supplied) {
      console.log("\n   ┌─────────────── SAVE THIS PASSWORD ───────────────┐");
      console.log(`     email    : ${email}`);
      console.log(`     password : ${password}`);
      console.log("   └──────────────────────────────────────────────────┘");
      console.log("   It is shown once. Change it anytime at app.supafone.ai,");
      console.log("   or use Sign in with Google / forgot-password instead.");
    }

    console.log("\nRe-checking the link …");
    const linked = await status();
    if (linked) {
      console.log("\nNext:");
      console.log("  npm run factory -- --url <site> --provision --area-code 415");
    } else {
      console.log("\nAccount exists but access is not ready yet — retry in a moment.");
    }
    return;
  }

  /* ---------- slower alternative: magic link ---------- */
  if (flag("send")) {
    console.log(`\n📧 Sending a magic link to ${email} …`);
    const res = await sendMagicLink(email);
    console.log(`   HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
    console.log(res.ok ? "   Click it, then re-run `npm run link`." : "   Failed — try --create.");
    return;
  }

  const cfg = (await productAuthConfig()) as { google_enabled?: boolean; magic_link_enabled?: boolean };
  console.log("\nFix it (all use the SAME email, which is what matters):");
  console.log("  → npm run link -- --create        INSTANT. Creates the account via the API.");
  if (cfg.magic_link_enabled) console.log("    npm run link -- --send          emails a magic link to click");
  if (cfg.google_enabled) console.log("    Sign in with Google at https://app.supafone.ai");
}

main().catch((e) => {
  console.error("\nFailed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
