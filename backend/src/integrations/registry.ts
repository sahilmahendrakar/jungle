import type { IntegrationAdapter } from "./types";

// Process-wide registry of integration adapters, keyed by integration key. Mirrors the
// Provisioner registry in provisioner.ts: adapters are registered once at boot
// (registerBuiltinIntegrations, called from index.ts) and looked up by key at runtime. Keeping
// this a plain module-level map (not a class) matches the provisioner pattern and keeps callers
// a bare `adapterFor(key)` away from an adapter.

const registry = new Map<string, IntegrationAdapter>();

export function registerAdapter(adapter: IntegrationAdapter): void {
  registry.set(adapter.key, adapter);
}

export function adapterFor(key: string): IntegrationAdapter | undefined {
  return registry.get(key);
}

export function allAdapters(): IntegrationAdapter[] {
  return [...registry.values()];
}
