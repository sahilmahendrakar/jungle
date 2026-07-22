import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { Shell } from "@/components/Shell";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--fraunces", axes: ["SOFT", "WONK", "opsz"] });
const inter = Inter({ subsets: ["latin"], variable: "--inter" });

export const metadata: Metadata = {
  title: "Liana — workflows that run themselves",
  description: "Ask in plain words, and it happens on schedule. Briefings, digests, reports — delivered in Slack, iMessage, or Telegram.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        <AuthProvider>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}
