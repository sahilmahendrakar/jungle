// The integration catalog: an agent starts as a blank chat agent and can have zero or more of
// these attached. Each entry describes its per-agent config shape (rendered by the frontend's
// integration picker/settings UI) and what it grants at runtime (backend/src/runners.ts,
// runner/src/runner.ts). GitHub is the only one actually wired up today; the rest are catalog
// entries so the picker UI has real content and a clear place to plug in the next one.

export interface IntegrationConfigField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface IntegrationType {
  key: string;
  name: string;
  description: string;
  configFields: IntegrationConfigField[];
  // Shown in the picker, disabled — the integration type exists in the catalog but isn't
  // wired up to grant anything yet.
  comingSoon?: boolean;
}

export const INTEGRATION_TYPES: IntegrationType[] = [
  {
    key: "github",
    name: "GitHub",
    description: "Pick a repo. Agent can clone, read code, open PRs & commit via git + gh CLI.",
    configFields: [{ key: "repo", label: "Repository", placeholder: "owner/name" }],
  },
  {
    key: "linear",
    name: "Linear",
    description: "Read & update issues in a chosen Linear team via Linear's MCP server.",
    configFields: [{ key: "team", label: "Team" }],
    comingSoon: true,
  },
  {
    key: "google-drive",
    name: "Google Drive",
    description: "Search and read docs/sheets from a connected Drive folder.",
    configFields: [{ key: "folder", label: "Folder" }],
    comingSoon: true,
  },
  {
    key: "notion",
    name: "Notion",
    description: "Read & write pages in a connected workspace.",
    configFields: [{ key: "workspace", label: "Workspace" }],
    comingSoon: true,
  },
];

export function getIntegrationType(key: string): IntegrationType | undefined {
  return INTEGRATION_TYPES.find((t) => t.key === key);
}

export function isKnownIntegration(key: string): boolean {
  return INTEGRATION_TYPES.some((t) => t.key === key);
}

// One integration attached to a specific agent, as returned by GET /api/agents/:id/integrations.
export interface AgentIntegration {
  agent_id: string;
  integration_key: string;
  config: Record<string, unknown>;
}
