import { navigate } from "./route";
import { Fireflies } from "./Fireflies";

// A jaguar in the logo's language: flat, curvy, overlapping organic shapes.
// Amber coat, rosettes in the deep-green background color, plus one spot each
// in the mark's teal, violet, and lime. Head faces right — she prowls inward.
function Jaguar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 340 220" className={className} aria-hidden>
      {/* tail — long curl off the rump */}
      <path
        d="M64 92 C34 82 20 54 44 36"
        fill="none"
        stroke="#f2a900"
        strokeWidth="15"
        strokeLinecap="round"
      />
      {/* legs — mid-stride */}
      <line x1="94" y1="118" x2="72" y2="196" stroke="#f2a900" strokeWidth="20" strokeLinecap="round" />
      <line x1="116" y1="128" x2="122" y2="198" stroke="#f2a900" strokeWidth="20" strokeLinecap="round" />
      <line x1="220" y1="124" x2="208" y2="198" stroke="#f2a900" strokeWidth="20" strokeLinecap="round" />
      <line x1="246" y1="116" x2="264" y2="192" stroke="#f2a900" strokeWidth="20" strokeLinecap="round" />
      {/* ears — bases tucked behind the head blob */}
      <circle cx="252" cy="42" r="10" fill="#f2a900" />
      <circle cx="292" cy="40" r="10" fill="#f2a900" />
      {/* body */}
      <path
        d="M66 96 C74 62 148 50 210 60 C258 68 270 100 252 128 C224 152 122 152 86 136 C64 126 60 112 66 96 Z"
        fill="#f2a900"
      />
      {/* head */}
      <path
        d="M240 76 C238 50 264 36 288 44 C310 52 314 82 298 96 C280 112 244 104 240 76 Z"
        fill="#f2a900"
      />
      {/* eye */}
      <circle cx="283" cy="66" r="4.5" fill="#04271a" />
      {/* rosettes */}
      <ellipse cx="124" cy="92" rx="11" ry="8" fill="#04271a" transform="rotate(-15 124 92)" />
      <circle cx="168" cy="108" r="9" fill="#04271a" />
      <circle cx="204" cy="86" r="8" fill="#04271a" />
      <circle cx="98" cy="74" r="6" fill="#1fb89b" />
      <circle cx="146" cy="126" r="6" fill="#8b5cf6" />
      <circle cx="222" cy="118" r="6" fill="#8fd14f" />
    </svg>
  );
}

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

      {/* Jaguar prowling in from the lower-left corner */}
      <Jaguar className="jl-reveal absolute bottom-6 left-6 z-0 hidden w-52 md:block lg:left-12 lg:w-64" />
    </main>
  );
}
