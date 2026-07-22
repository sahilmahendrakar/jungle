"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { Landing } from "@/components/Landing";

// Auth gate for every route: signed out (or auth unconfigured) shows the landing page wherever
// you land; signed in shows the app shell. Also completes Slack sign-up links (?link=<code>
// from Liana's "Create your account" button) right after sign-in.

function linkCodeFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("link");
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { status, me, signOut, refreshMe } = useAuth();
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkBanner, setLinkBanner] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setLinkCode(linkCodeFromUrl());
  }, []);

  // Redeem the Slack link code once we're signed in, then drop it from the URL.
  useEffect(() => {
    if (status !== "ready" || !linkCode) return;
    let stale = false;
    void (async () => {
      try {
        const r = await api<{ teamName: string | null }>("/api/liana/link/slack", {
          method: "POST",
          body: JSON.stringify({ code: linkCode }),
        });
        if (stale) return;
        setLinkBanner({
          ok: true,
          text: `Slack connected${r.teamName ? ` — ${r.teamName}` : ""}. Head back to Slack and tell Liana what you'd like automated.`,
        });
        void refreshMe();
      } catch (e) {
        if (!stale) setLinkBanner({ ok: false, text: (e as Error).message });
      } finally {
        if (!stale) {
          setLinkCode(null);
          const url = new URL(window.location.href);
          url.searchParams.delete("link");
          window.history.replaceState({}, "", url.pathname + url.search);
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [status, linkCode, refreshMe]);

  if (status === "loading") {
    return (
      <div className="boot">
        <span className="leaf">🌿</span>
      </div>
    );
  }

  if (status === "signedout" || status === "unconfigured") {
    return <Landing hasLinkCode={!!linkCode} />;
  }

  return (
    <div className="shell">
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="leaf">🌿</span>Liana
        </Link>
        <Link href="/workflows" className="navlink">
          Workflows
        </Link>
        <Link href="/connections" className="navlink">
          Connections
        </Link>
        <Link href="/settings" className="navlink">
          Settings
        </Link>
        <span className="spacer" />
        <span className="who">
          {me?.avatarUrl && <img className="who-avatar" src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <button className="who-out" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </nav>
      {linkBanner && (
        <p className={linkBanner.ok ? "banner ok" : "banner bad"} onClick={() => setLinkBanner(null)}>
          {linkBanner.text}
        </p>
      )}
      {children}
    </div>
  );
}
