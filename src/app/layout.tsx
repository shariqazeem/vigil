import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";
import "../styles/tokens.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap", weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap", weight: ["400", "500"] });
const serif = Instrument_Serif({ subsets: ["latin"], variable: "--font-instrument", display: "swap", weight: ["400"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.VIGIL_BASE_URL ?? "http://localhost:3100"),
  title: "Vigil — the agent that keeps watch over the things you own",
  description:
    "Nine out of ten recalled products are never returned, because the notice goes to an address you left years ago. Tell Vigil what is in your home. It checks it against live federal safety data, night after night, and wakes you only when one of your things becomes dangerous.",
  openGraph: {
    title: "Vigil — it watches your things so you don't have to remember to",
    description: "An autonomous agent that checks the things in your home against NHTSA, CPSC and FDA safety data, and only surfaces when there is a real decision.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
