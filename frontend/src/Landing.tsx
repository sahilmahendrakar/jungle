import type { CSSProperties } from "react";
import { navigate } from "./route";

// Fireflies drifting through the night jungle. Positions/timings are fixed so the
// scene is calm and identical on every visit. Mostly lime, with a few strays in the
// logo's other colors — teal, amber, violet — as quiet echoes of the mark.
const FIREFLIES = [
  { left: "12%", top: "28%", size: 4, drift: 14, flicker: 3.2, delay: 0, color: "var(--jl-lime)" },
  { left: "22%", top: "66%", size: 3, drift: 18, flicker: 4.1, delay: 1.2, color: "var(--jl-teal)" },
  { left: "38%", top: "18%", size: 3, drift: 16, flicker: 3.7, delay: 2.1, color: "var(--jl-lime)" },
  { left: "64%", top: "24%", size: 4, drift: 20, flicker: 4.6, delay: 0.6, color: "var(--jl-amber)" },
  { left: "78%", top: "58%", size: 3, drift: 15, flicker: 3.4, delay: 1.8, color: "var(--jl-lime)" },
  { left: "88%", top: "34%", size: 4, drift: 19, flicker: 4.2, delay: 2.6, color: "var(--jl-violet)" },
  { left: "50%", top: "80%", size: 3, drift: 17, flicker: 3.9, delay: 0.9, color: "var(--jl-teal)" },
];

export function Landing() {
  const goSignIn = () => navigate("/login");

  return (
    <main className="jungle-landing relative flex min-h-screen flex-col overflow-hidden">
      <style>{`
        .jungle-landing {
          --jl-bg: #04271a;
          --jl-ink: #f0f5ee;
          --jl-ink-dim: rgba(240, 245, 238, 0.62);
          --jl-lime: #8fd14f;
          --jl-teal: #1fb89b;
          --jl-amber: #f2a900;
          --jl-violet: #8b5cf6;
          background:
            radial-gradient(90rem 60rem at 50% -18%, rgba(31, 184, 155, 0.16), transparent 60%),
            radial-gradient(70rem 50rem at 108% 110%, rgba(139, 92, 246, 0.14), transparent 60%),
            radial-gradient(60rem 44rem at -10% 96%, rgba(242, 169, 0, 0.11), transparent 55%),
            var(--jl-bg);
          color: var(--jl-ink);
        }
        .jungle-landing::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0.5;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.04 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
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
        .jl-firefly {
          position: absolute;
          border-radius: 9999px;
          background: var(--jl-glow);
          box-shadow: 0 0 10px 2px color-mix(in srgb, var(--jl-glow) 55%, transparent);
          animation:
            jl-drift var(--jl-drift) ease-in-out infinite alternate,
            jl-flicker var(--jl-flicker) ease-in-out infinite;
          animation-delay: var(--jl-delay);
        }
        @keyframes jl-drift {
          from { transform: translate(0, 0); }
          to { transform: translate(26px, -34px); }
        }
        @keyframes jl-flicker {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.9; }
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
        @media (prefers-reduced-motion: reduce) {
          .jl-reveal { animation: none; opacity: 1; }
          .jl-firefly { animation: none; opacity: 0.5; }
          .jl-cta, .jl-cta-arrow { transition: none; }
        }
      `}</style>

      {/* Fireflies */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {FIREFLIES.map((f, i) => (
          <span
            key={i}
            className="jl-firefly"
            style={
              {
                left: f.left,
                top: f.top,
                width: f.size,
                height: f.size,
                "--jl-drift": `${f.drift}s`,
                "--jl-flicker": `${f.flicker}s`,
                "--jl-delay": `${f.delay}s`,
                "--jl-glow": f.color,
              } as CSSProperties
            }
          />
        ))}
      </div>

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
    </main>
  );
}
