// Generate Granola's bold spiral as an SVG stroked path (Archimedean spiral, round cap) +
// center blob, matched to the reference app-icon geometry. Prints a RichGlyph TS snippet.
const CX = 20, CY = 20;
const R_OUT = 12.5;
const R_END = 5.5;
const TURNS = 1.55;
const START_DEG = -55;   // tail at ~1:30 o'clock
const DIR = -1;          // θ decreasing = visually counterclockwise (SVG y-down)

const pts = [];
const steps = 400;
const th0 = (START_DEG * Math.PI) / 180;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const th = th0 + DIR * 2 * Math.PI * TURNS * t;
  const r = R_OUT - (R_OUT - R_END) * t;
  pts.push(`${(CX + r * Math.cos(th)).toFixed(2)} ${(CY + r * Math.sin(th)).toFixed(2)}`);
}
const spiral = `M${pts.join("L")}`;
const BLOB_R = 4.2;
const blob = `M${CX - BLOB_R} ${CY}a${BLOB_R} ${BLOB_R} 0 1 0 ${2 * BLOB_R} 0a${BLOB_R} ${BLOB_R} 0 1 0 ${-2 * BLOB_R} 0z`;

console.log(`  granola: {
    viewBox: "0 0 40 40",
    background: { fill: "#b2c248", rx: 9 },
    paths: [
      { d: "${spiral}", stroke: "#1e1e1e", strokeWidth: 3.4 },
      { d: "${blob}", fill: "#1e1e1e" },
    ],
  },`);
