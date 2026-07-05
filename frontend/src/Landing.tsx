import { navigate } from "./route";
import { Fireflies } from "./Fireflies";

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
        @media (prefers-reduced-motion: reduce) {
          .jl-reveal { animation: none; opacity: 1; }
          .jl-cta, .jl-cta-arrow { transition: none; }
        }
      `}</style>

      <Fireflies />

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
