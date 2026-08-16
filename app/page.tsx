import type { Metadata } from "next";
import FactoryPage from "@/app/factory/page";

export const metadata: Metadata = {
  title: "Scrape a site, talk to the agent",
  description:
    "Paste a website. Voia scrapes it, launches a Voice Watcher agent, and lets you talk over WebRTC — multilingual, self-healing.",
};

/**
 * Home is the mixed product: scrape → knowledge → hosted agent with
 * Voice Watcher + multilingual continuity → browser WebRTC talk.
 */
export default function Home() {
  return <FactoryPage />;
}
