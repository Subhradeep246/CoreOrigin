import type { Metadata } from "next";
import { headers } from "next/headers";
import { VoiaExperience } from "./components/VoiaExperience";

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

export default function Home() {
  return <VoiaExperience />;
}
