// Regenerates the runner's copies of the shared wire contracts from the source of truth in
// shared/src. The runner is a standalone (non-workspace) package that cannot import @jungle/shared
// at runtime, so it ships verbatim copies: src/protocol.ts (per-agent runner protocol) and
// src/host-protocol.ts (host-control protocol, used by the daemon). Runs via the runner's
// `prebuild` hook (npm run build). Do not edit the generated files by hand — edit the shared
// sources and rebuild.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// [shared source, runner dest] pairs to keep in sync.
const files = [
  ["../../shared/src/runner-protocol.ts", "../src/protocol.ts"],
  ["../../shared/src/host-protocol.ts", "../src/host-protocol.ts"],
];

for (const [srcRel, destRel] of files) {
  const src = resolve(here, srcRel);
  const dest = resolve(here, destRel);
  const banner =
    `// GENERATED FILE — do not edit. Source of truth: shared/src/${srcRel.split("/").pop()}\n` +
    "// Regenerate with `npm run build` (runs scripts/sync-protocol.mjs) in the runner package.\n\n";
  if (!existsSync(src)) {
    // Isolated checkout without the workspace (e.g. a bare runner Docker context): keep the
    // committed copy rather than failing the build. The Docker image builds from prebuilt dist/,
    // so this path only matters for a manual standalone `npm run build`.
    console.warn(`[sync-protocol] shared source not found at ${src}; keeping existing ${dest}`);
    continue;
  }
  writeFileSync(dest, banner + readFileSync(src, "utf8"));
  console.log(`[sync-protocol] wrote ${dest} from ${srcRel.replace("../../", "")}`);
}
