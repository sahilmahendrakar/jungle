// The integrations subsystem: a registry of per-service adapters behind Jungle's integration
// catalog (@jungle/shared INTEGRATION_TYPES). Register the built-in adapters once at boot
// (called from backend/src/index.ts, like setProvisioner), then runners.ts / routes/agents.ts
// dispatch by key via adapterFor(). Adding an integration = one adapter + one register call here.

import { registerAdapter } from "./registry";
import { githubAdapter } from "./github";
import { gmailAdapter } from "./gmail";
import { googleDriveAdapter } from "./google-drive";
import { linearAdapter, notionAdapter, granolaAdapter } from "./providers";

export { registerAdapter, adapterFor, allAdapters } from "./registry";
export type { IntegrationAdapter, ResolveConfigCtx } from "./types";

export function registerBuiltinIntegrations(): void {
  registerAdapter(githubAdapter);
  registerAdapter(gmailAdapter);
  registerAdapter(googleDriveAdapter);
  registerAdapter(linearAdapter);
  registerAdapter(notionAdapter);
  registerAdapter(granolaAdapter);
}
