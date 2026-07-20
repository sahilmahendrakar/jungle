import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--fraunces", axes: ["SOFT", "WONK", "opsz"] });
const inter = Inter({ subsets: ["latin"], variable: "--inter" });

export const metadata: Metadata = {
  title: "Liana — workflows that run themselves",
  description: "Ask in Slack, and it happens on schedule. Briefings, digests, reports — delivered to your DMs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="brand">
              <span className="leaf">🌿</span>Liana
            </Link>
            <Link href="/" className="navlink">
              Workflows
            </Link>
            <Link href="/connections" className="navlink">
              Connections
            </Link>
            <span className="spacer" />
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
