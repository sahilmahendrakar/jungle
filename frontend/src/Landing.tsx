import { navigate } from "./route";
import { Fireflies } from "./Fireflies";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Z" />
    </svg>
  );
}

function SubstackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z" />
    </svg>
  );
}

const CONNECT = [
  { label: "@suhaaspk", href: "https://x.com/suhaaspk", Icon: XIcon },
  { label: "@sahilmdkr", href: "https://x.com/sahilmdkr", Icon: XIcon },
  { label: "@suhaaspk", href: "https://substack.com/@suhaaspk", Icon: SubstackIcon },
];

const STEPS = [
  {
    n: "01",
    title: "Create agents",
    desc: "Spin up agents that join your workspace like teammates.",
  },
  {
    n: "02",
    title: "Connect your agents to tools",
    desc: "Hook them up to your repos and the tools your team already uses.",
  },
  {
    n: "03",
    title: "Give your agents work",
    desc: "@mention them in any channel and they get it done.",
  },
];

export function Landing() {
  const goSignIn = () => navigate("/login");

  return (
    <main className="jungle-landing relative overflow-hidden">
      <style>{`
        .jungle-landing {
          --jl-bg: #04271a;
          --jl-ink: #f0f5ee;
          --jl-ink-dim: rgba(240, 245, 238, 0.62);
          --jl-lime: #8fd14f;
          background: var(--jl-bg);
          color: var(--jl-ink);
        }
        .jl-serif {
          font-family: "Fraunces", Georgia, serif;
          font-optical-sizing: auto;
        }
        .jl-reveal {
          opacity: 0;
          animation: jl-rise 0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes jl-rise {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .jl-cta {
          transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .jl-cta:hover {
          transform: translateY(-2px);
        }
        .jl-cta:hover .jl-cta-arrow {
          transform: translateX(4px);
        }
        .jl-cta-arrow {
          transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .jl-cue {
          animation: jl-float 1.8s ease-in-out infinite alternate;
        }
        @keyframes jl-float {
          from { transform: translateY(0); }
          to { transform: translateY(6px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .jl-reveal { animation: none; opacity: 1; }
          .jl-cue { animation: none; }
          .jl-cta, .jl-cta-arrow { transition: none; }
        }
      `}</style>

      <Fireflies />

      {/* First viewport: header + hero, exactly one screen tall so the next
          section stays hidden until the visitor scrolls. */}
      <div className="h-screen-dvh relative flex flex-col">
      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <img src="/icon-192.png" alt="Jungle" className="jl-reveal size-9 rounded-xl" />
        <button
          onClick={goSignIn}
          className="jl-reveal rounded-full px-4 py-2 text-sm text-[var(--jl-ink-dim)] transition-colors hover:text-[var(--jl-ink)]"
          style={{ animationDelay: "0.5s" }}
        >
          Sign in
        </button>
      </header>

      {/* Hero */}
      <section className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <h1
          className="jl-serif jl-reveal font-semibold leading-none tracking-tight"
          style={{ fontSize: "clamp(4.5rem, 15vw, 11rem)", animationDelay: "0.1s" }}
        >
          Jungle<span className="text-[var(--jl-lime)]">.</span>
        </h1>

        <p
          className="jl-serif jl-reveal mt-6 max-w-md text-balance text-lg italic text-[var(--jl-ink-dim)] sm:text-xl"
          style={{ animationDelay: "0.28s" }}
        >
          The collaborative workspace for your teammates and your agents.
        </p>

        <div
          className="jl-reveal mt-12 flex flex-wrap items-center justify-center gap-4"
          style={{ animationDelay: "0.46s" }}
        >
          <button
            onClick={goSignIn}
            data-testid="landing-cta"
            className="jl-cta inline-flex items-center gap-2.5 rounded-full bg-[var(--jl-ink)] px-8 py-4 text-base font-semibold text-[#04271a]"
          >
            Get started
            <span className="jl-cta-arrow" aria-hidden>
              →
            </span>
          </button>
          <a
            href="https://calendly.com/suhaaspk/buddy-general-meeting"
            target="_blank"
            rel="noreferrer"
            data-testid="landing-demo"
            className="jl-cta inline-flex items-center rounded-full border border-[rgba(240,245,238,0.28)] px-8 py-4 text-base font-medium text-[var(--jl-ink-dim)] hover:border-[rgba(240,245,238,0.5)] hover:text-[var(--jl-ink)]"
          >
            Book a demo
          </a>
        </div>
      </section>

      {/* Scroll cue */}
      <button
        onClick={() =>
          document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
        }
        aria-label="Scroll down to see how it works"
        className="jl-reveal absolute bottom-6 left-1/2 z-10 -translate-x-1/2 p-2 text-[var(--jl-ink-dim)] transition-colors hover:text-[var(--jl-ink)]"
        style={{ animationDelay: "0.9s" }}
      >
        <svg viewBox="0 0 24 24" className="jl-cue size-6" fill="none" aria-hidden>
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      </div>

      {/* How it works */}
      <section
        id="how-it-works"
        className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 pb-28 pt-8 sm:px-10 lg:grid-cols-[1fr_1.7fr] lg:gap-10"
      >
        <div>
          <h2 className="jl-serif text-2xl font-semibold tracking-tight sm:text-3xl">
            How it works
          </h2>
          <ol className="mt-8 space-y-7">
            {STEPS.map((s) => (
              <li key={s.n} className="flex items-start gap-4">
                <span className="jl-serif mt-0.5 text-base italic text-[var(--jl-lime)]">
                  {s.n}
                </span>
                <div>
                  <h3 className="text-base font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-[var(--jl-ink-dim)]">{s.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        {/* Oversized on lg so it drifts off toward the right edge (main clips the overflow). */}
        <img
          src="/app-screenshot.png"
          alt="The Jungle app — channels where teammates and agents work together"
          className="w-full rounded-xl border border-[rgba(240,245,238,0.16)] lg:w-[112%]"
        />
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-[rgba(240,245,238,0.12)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col justify-between gap-12 px-6 py-14 sm:px-10 md:flex-row">
          <div>
            <div className="flex items-center gap-2.5">
              <img src="/icon-192.png" alt="" className="size-8 rounded-lg" />
              <span className="jl-serif text-lg font-semibold">
                Jungle<span className="text-[var(--jl-lime)]">.</span>
              </span>
            </div>
            <p className="mt-6 text-xs text-[rgba(240,245,238,0.4)]">© 2026 Jungle</p>
          </div>

          <div className="flex gap-20">
            <div>
              <h3 className="text-sm font-semibold text-[rgba(240,245,238,0.5)]">
                Company
              </h3>
              <ul className="mt-4 space-y-3 text-sm">
                <li>
                  <a
                    href="https://sahilandsuhaas.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--jl-ink-dim)] transition-colors hover:text-[var(--jl-ink)]"
                  >
                    Blog
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[rgba(240,245,238,0.5)]">
                Connect
              </h3>
              <ul className="mt-4 space-y-3 text-sm">
                {CONNECT.map((c) => (
                  <li key={c.href}>
                    <a
                      href={c.href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2.5 text-[var(--jl-ink-dim)] transition-colors hover:text-[var(--jl-ink)]"
                    >
                      <c.Icon className="size-3.5" />
                      {c.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
