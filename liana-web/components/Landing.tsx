"use client";

import { useAuth } from "@/components/AuthProvider";
import { BrandTile, GoogleG } from "@/components/icons";

// The signed-out front door. One idea, one action: what Liana does, in her own voice, and a
// single Google button. The three chat surfaces appear as tiles so people see where she lives —
// connecting happens after sign-in, so the tiles inform rather than pretend to be buttons.

export function Landing({ hasLinkCode }: { hasLinkCode: boolean }) {
  const { status, signIn, error } = useAuth();

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="brand">
          <span className="leaf">🌿</span>Liana
        </span>
      </header>

      <section className="hero">
        <h1>Dead simple agentic workflows.</h1>
        <p className="hero-sub">
          Tell Liana what you want in plain words — a morning briefing, a weekly digest, prep before
          every meeting. She sets it up, runs it on schedule, and delivers it where you talk.
        </p>

        {hasLinkCode && (
          <p className="link-note">Almost there — sign in with Google and I&apos;ll connect your Slack.</p>
        )}

        {status === "unconfigured" ? (
          <p className="muted">Sign-in isn&apos;t configured on this deployment.</p>
        ) : (
          <button className="google-btn" onClick={() => void signIn()}>
            <GoogleG />
            Continue with Google
          </button>
        )}
        {error && <p className="error-note" style={{ marginTop: 12 }}>{error}</p>}

        <div className="vignette" aria-hidden>
          <div className="bubble you">Give me a morning briefing every day at 8am</div>
          <div className="bubble liana">
            <span className="bubble-who">🌿 Liana</span>
            Done — <b>Morning briefing</b>, every day at 8:00 AM, from your email, calendar, and
            GitHub. Want me to create it?
          </div>
        </div>
      </section>

      <section className="surfaces">
        <h2>She lives where you already talk</h2>
        <div className="surface-grid">
          <div className="surface">
            <BrandTile channel="slack" />
            <p className="surface-name">Slack</p>
            <p className="surface-sub">Add @Liana to your workspace. DM her, or mention her in any thread.</p>
          </div>
          <div className="surface">
            <BrandTile channel="imessage" />
            <p className="surface-name">iMessage</p>
            <p className="surface-sub">Text Liana like a friend. Briefings arrive as texts.</p>
          </div>
          <div className="surface">
            <BrandTile channel="telegram" />
            <p className="surface-name">Telegram</p>
            <p className="surface-sub">One tap to link — chat and get results in Telegram.</p>
          </div>
        </div>
        <p className="surface-hint">Sign in, then connect any of them — it takes about a minute.</p>
      </section>

      <footer className="landing-foot">🌿 Liana — dead simple agentic workflows</footer>
    </div>
  );
}
