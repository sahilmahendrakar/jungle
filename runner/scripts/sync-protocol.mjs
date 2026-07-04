// Regenerates runner/src/protocol.ts from the shared source of truth
// (shared/src/runner-protocol.ts). The runner is a standalone (non-workspace) package that
// cannot import @jungle/shared at runtime, so it ships a verbatim copy of the protocol types.
// Runs via the runner's `prebuild` hook (npm run build). Do not edit runner/src/protocol.ts by
// hand — edit shared/src/runner-protocol.ts and rebuild.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../shared/src/runner-protocol.ts");
const dest = resolve(here, "../src/protocol.ts");

const BANNER =
  "// GENERATED FILE — do not edit. Source of truth: shared/src/runner-protocol.ts\n" +
  "// Regenerate with `npm run build` (runs scripts/sync-protocol.mjs) in the runner package.\n\n";

if (!existsSync(src)) {
  // Isolated checkout without the workspace (e.g. a bare runner Docker context): keep the
  // committed copy rather than failing the build. The Docker image builds from prebuilt dist/,
  // so this path only matters for a manual standalone `npm run build`.
  console.warn(`[sync-protocol] shared source not found at ${src}; keeping existing ${dest}`);
  process.exit(0);
}

writeFileSync(dest, BANNER + readFileSync(src, "utf8"));
console.log(`[sync-protocol] wrote ${dest} from shared/src/runner-protocol.ts`);
