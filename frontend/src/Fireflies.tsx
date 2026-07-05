import type { CSSProperties } from "react";

// Brand palette pulled from the Jungle mark.
const LIME = "#8fd14f";
const TEAL = "#1fb89b";
const AMBER = "#f2a900";
const VIOLET = "#8b5cf6";

// Fireflies drifting through the night jungle. Positions/timings are fixed so the
// scene is calm and identical on every visit. Mostly lime, with a few strays in the
// logo's other colors — teal, amber, violet — as quiet echoes of the mark.
const FIREFLIES = [
  { left: "12%", top: "28%", size: 4, drift: 14, flicker: 3.2, delay: 0, color: LIME },
  { left: "22%", top: "66%", size: 3, drift: 18, flicker: 4.1, delay: 1.2, color: TEAL },
  { left: "38%", top: "18%", size: 3, drift: 16, flicker: 3.7, delay: 2.1, color: LIME },
  { left: "64%", top: "24%", size: 4, drift: 20, flicker: 4.6, delay: 0.6, color: AMBER },
  { left: "78%", top: "58%", size: 3, drift: 15, flicker: 3.4, delay: 1.8, color: LIME },
  { left: "88%", top: "34%", size: 4, drift: 19, flicker: 4.2, delay: 2.6, color: VIOLET },
  { left: "50%", top: "80%", size: 3, drift: 17, flicker: 3.9, delay: 0.9, color: TEAL },
];

// Full-bleed overlay of drifting fireflies for dark forest-green surfaces.
// The parent must be positioned (relative/absolute).
export function Fireflies() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <style>{`
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
        @media (prefers-reduced-motion: reduce) {
          .jl-firefly { animation: none; opacity: 0.5; }
        }
      `}</style>
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
  );
}
