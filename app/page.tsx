import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host") ?? "coinorigin.app";
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(requestHost) ? requestHost : "coinorigin.app";
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : safeHost.startsWith("localhost")
      ? "http"
      : "https";
  const imageUrl = `${protocol}://${safeHost}/og.png`;

  return {
    title: "Find the right care, in your voice",
    description:
      "A multilingual voice and chat assistant for safer care navigation and appointment requests.",
    openGraph: {
      title: "Care starts with being heard.",
      description: "Meet Voia by CoinOrigin — multilingual care navigation by voice and chat.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Voia by CoinOrigin" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Care starts with being heard.",
      description: "Meet Voia by CoinOrigin — multilingual care navigation by voice and chat.",
      images: [imageUrl],
    },
  };
}

/**
 * Home.
 *
 * The previous implementation rendered `<VoiaExperience />`, a component that
 * is not present in the repository — the import broke the dev compilation for
 * EVERY route, not just this one. Until that component lands, this is a small
 * working landing page that keeps the shell and points at the shipped surface.
 */
export default function Home() {
  return (
    <AppShell>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">CoinOrigin</p>
          <h1>
            Turn any website into a <em>callable AI receptionist</em>
          </h1>
          <p className="hero-lede">
            Paste a company URL. Supafone scrapes the site, builds its knowledge base,
            generates the agent graph and tools, provisions a number, and launches a
            working voice agent — in under two minutes.
          </p>
          <div className="hero-actions">
            <Link href="/factory" className="primary-button">
              Open the Agent Factory
            </Link>
          </div>
          <div className="hero-proof">
            <span>Scrape → knowledge base → agent graph</span>
            <span>Adversarial QA before launch</span>
            <span>Managed number, no Twilio account</span>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
