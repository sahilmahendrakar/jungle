// Provider resolution for non-Anthropic models. Each agent's model maps (via the shared
// MODEL_CATALOG) to a provider; anything other than "anthropic" is served by an Anthropic-
// compatible endpoint that the runner reaches by overriding ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN
// in the CLI child env. Here we turn a model id into the ProviderConfig the runner needs, reading
// the operator-owned API key from process.env. First-party Anthropic models resolve to null (the
// runner keeps using its container ANTHROPIC_API_KEY).
//
// Adding a tier-1 (Anthropic-compatible) model: add a MODEL_CATALOG row in @jungle/shared, then a
// PROVIDER_ENV entry here with its base URL + env var name. No other backend changes.
import { catalogEntry, type ModelProvider, type ProviderConfig } from "@jungle/shared";

// Per-provider endpoint + which env var holds its key. "anthropic" is intentionally absent — it's
// the first-party default (container ANTHROPIC_API_KEY) and never needs routing.
const PROVIDER_ENV: Record<Exclude<ModelProvider, "anthropic">, { baseUrl: string; envVar: string }> = {
  zai: { baseUrl: "https://api.z.ai/api/anthropic", envVar: "Z_AI_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.ai/anthropic", envVar: "MOONSHOT_API_KEY" },
};

// True when the model can actually run: Anthropic/default models always can; a routed provider's
// model only when its API key is present in the environment. Used to reject agent create/update
// with a clear 400 rather than provisioning an agent that fails every turn.
export function providerConfigured(model: string | null): boolean {
  const entry = catalogEntry(model);
  if (!entry || entry.provider === "anthropic") return true;
  return !!process.env[PROVIDER_ENV[entry.provider].envVar];
}

// Resolve the routing config for a model, or null for Anthropic/default models. Returns null (not
// a throw) when the provider key is missing so callers building a `configure` frame degrade to the
// Anthropic path with a loud per-turn failure rather than crashing the handshake; the HTTP layer
// (providerConfigured) is what blocks selecting an unconfigured model up front.
export function resolveProvider(model: string | null): ProviderConfig | null {
  const entry = catalogEntry(model);
  if (!entry || entry.provider === "anthropic") return null;
  const { baseUrl, envVar } = PROVIDER_ENV[entry.provider];
  const authToken = process.env[envVar];
  if (!authToken) {
    console.error(`[providers] ${envVar} not set; cannot route model ${model} to ${entry.provider}`);
    return null;
  }
  return {
    name: entry.provider,
    baseUrl,
    authToken,
    supportsEffort: entry.supportsEffort,
    contextWindow: entry.contextWindow,
  };
}
