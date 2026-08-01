import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://coinorigin.app"),
  title: {
    default: "Voia by CoinOrigin",
    template: "%s | Voia",
  },
  description:
    "Multilingual voice and chat support for care navigation and appointment requests.",
  applicationName: "Voia",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Voia by CoinOrigin",
    description: "Find the right care, in your voice.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Voia by CoinOrigin",
    description: "Find the right care, in your voice.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7f2",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
