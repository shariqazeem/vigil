import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "../styles/tokens.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.WARDEN_BASE_URL ?? "http://localhost:3100"),
  title: "Warden — an autonomous operator for software that is already running",
  description:
    "Warden watches the services you have running, investigates them when they break, fixes what your policy lets it fix, proves the fix by re-running the check that failed, and wakes you only when the decision is genuinely yours.",
  openGraph: {
    title: "Warden — your software should not need you awake to keep running",
    description: "An autonomous operator that investigates, fixes what its policy allows, and proves the fix by re-running the check that failed.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Warden — your software should not need you awake to keep running." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Warden — your software should not need you awake to keep running",
    description: "An autonomous operator that investigates, fixes what its policy allows, and proves the fix by re-running the check that failed.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
