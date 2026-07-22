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

// The declarative per-integration settings descriptor: the SINGLE source of truth for which
// per-workflow (= per-agent) config knobs an integration has. Consumed by the backend validators,
// the Liana web settings UI, the intake prompt, the draft card, and the main app's approvalKey().
// Distinct from `configFields` (the legacy free-text-only shape the main-app route renders): a
// SettingField carries enough structure (kind + required + default) for every surface to render
// and validate it without special-casing per integration.
//   - "repo": the GitHub repo picker (owner/name); required means a workflow can't run without it.
//   - "approval": a write-gate boolean, DEFAULT ON (require my approval before writes/sends). The
//     `key` is the actual config key stored in agent_integrations.config — gmail uses
//     `requireSendApproval`, every other write integration uses `requireApproval`.
//   - "text": a free-text field (github's commit-identity authorName/authorEmail); `advanced`
//     hides it behind a disclosure and keeps it out of the simplified Liana web UI.
export type IntegrationSettingField =
  | { kind: "repo"; key: "repo"; label: string; required: true }
  | { kind: "approval"; key: "requireSendApproval" | "requireApproval"; label: string }
  | { kind: "text"; key: string; label: string; placeholder?: string; advanced?: true };

// A per-USER account link that integrations are built on. Every integration relies on exactly
// one connection (an integration = a connection + per-agent settings): GitHub backs the github
// integration, the Google account backs gmail, and each remote-MCP integration (Linear/Notion/
// Granola/Drive) has its own. Connections are managed once in Settings → Connections; the
// `kind` says which OAuth route family serves it (their wire shapes differ, the UX is uniform).
export interface ConnectionType {
  key: string; // "github" | "google" | <integration key>
  name: string;
  description: string;
  kind: "github" | "google" | "integration";
}

export interface IntegrationType {
  key: string;
  name: string;
  description: string;
  // The per-user connection this integration is built on (see ConnectionType / CONNECTION_TYPES).
  connectionKey: string;
  configFields: IntegrationConfigField[];
  // The per-workflow settings this integration exposes (repo, write-approval, commit identity).
  // Empty/undefined for read-only integrations that grant the same tools to everyone. This is the
  // structured superset of configFields — see IntegrationSettingField and the helpers below.
  settings?: IntegrationSettingField[];
  // Shown in the picker, disabled — the integration type exists in the catalog but isn't
  // wired up to grant anything yet.
  comingSoon?: boolean;
  // Connection-based via the per-agent OAuth flow (POST /api/agents/:id/integrations/:key/
  // connect-url → provider consent → /auth/integrations/callback). The frontend renders a generic
  // "Connect" card for these (see IntegrationsEditor). Gmail is connection-based too but via the
  // per-user Google account in Settings, so it is NOT marked here — it has its own card.
  // "apikey" = connection-based but with pasted static credentials (PostHog personal API key,
  // Mixpanel service account) instead of an OAuth round-trip; connected from the Liana web app.
  connection?: "oauth" | "apikey";
  // The integration exposes only read-only tools (e.g. Granola: query notes/transcripts). There's
  // nothing to approve, so the write-approval toggle is hidden and its tools always run.
  readOnly?: boolean;
}

export const INTEGRATION_TYPES: IntegrationType[] = [
  {
    key: "github",
    name: "GitHub",
    description: "Pick a repo. Agent can clone, read code, open PRs & commit via git + gh CLI.",
    connectionKey: "github",
    configFields: [{ key: "repo", label: "Repository", placeholder: "owner/name" }],
    settings: [
      { kind: "repo", key: "repo", label: "Repository", required: true },
      { kind: "text", key: "authorName", label: "Commit author name", placeholder: "e.g. Sahil Mahendrakar", advanced: true },
      { kind: "text", key: "authorEmail", label: "Commit author email", placeholder: "12345+you@users.noreply.github.com", advanced: true },
    ],
    // Optional config keys beyond configFields (rendered by IntegrationsEditor under an "Advanced"
    // disclosure on the GitHub row; validated/normalized by the backend adapter's resolveConfig):
    //   authorName / authorEmail — the agent's git commit identity. Point these at a real GitHub
    //   account (its `12345+login@users.noreply.github.com` noreply email works) so the agent's
    //   commits are attributed to that account instead of showing as unverified on GitHub.
  },
  {
    key: "gmail",
    name: "Gmail",
    description: "Read, search & send email from your connected Gmail. Sending can require your approval.",
    // Connection-based, not a typed field: the mailbox comes from the attaching user's connected
    // Google account (see Settings → Connections), so there are no free-text config fields. The
    // frontend renders this card specially (connection status + a send-approval toggle).
    connectionKey: "google",
    configFields: [],
    settings: [{ kind: "approval", key: "requireSendApproval", label: "Ask me before it sends email" }],
  },
  {
    key: "linear",
    name: "Linear",
    description: "Read, create & update Linear issues, projects & comments via Linear's MCP server.",
    // Connection-based (OAuth to Linear's MCP server); the only per-agent config is the write-
    // approval toggle, rendered specially by the connection card.
    connectionKey: "linear",
    configFields: [],
    connection: "oauth",
    settings: [{ kind: "approval", key: "requireApproval", label: "Ask me before it makes changes in Linear" }],
  },
  {
    key: "google-drive",
    name: "Google Drive",
    description: "Search, read, create & update files in a connected Google Drive.",
    connectionKey: "google-drive",
    configFields: [],
    connection: "oauth",
    settings: [{ kind: "approval", key: "requireApproval", label: "Ask me before it changes files in Drive" }],
  },
  {
    key: "google-calendar",
    name: "Google Calendar",
    description: "Read, create & update events on a connected Google Calendar.",
    connectionKey: "google-calendar",
    configFields: [],
    connection: "oauth",
    settings: [{ kind: "approval", key: "requireApproval", label: "Ask me before it changes my calendar" }],
  },
  {
    key: "notion",
    name: "Notion",
    description: "Search, read & write pages and databases in a connected Notion workspace.",
    connectionKey: "notion",
    configFields: [],
    connection: "oauth",
    settings: [{ kind: "approval", key: "requireApproval", label: "Ask me before it makes changes in Notion" }],
  },
  {
    key: "granola",
    name: "Granola",
    description: "Search and read your Granola meeting notes and transcripts.",
    connectionKey: "granola",
    configFields: [],
    connection: "oauth",
    readOnly: true,
  },
  {
    key: "x",
    name: "X (Twitter)",
    description: "Summarize activity on your X account — your recent tweets, mentions, replies and notifications.",
    connectionKey: "x",
    configFields: [],
    connection: "oauth",
    readOnly: true,
  },
  {
    key: "posthog",
    name: "PostHog",
    description: "Query product analytics — events, insights, trends, funnels & session data via PostHog's MCP server.",
    connectionKey: "posthog",
    configFields: [],
    connection: "oauth",
    readOnly: true,
  },
  {
    key: "mixpanel",
    name: "Mixpanel",
    description: "Query product analytics — events, reports, metrics & dashboards via Mixpanel's MCP server.",
    connectionKey: "mixpanel",
    configFields: [],
    connection: "oauth",
    readOnly: true,
  },
];

// The per-user connection catalog — everything a user can link in Settings → Connections.
// GitHub and Google are first-class OAuth flows with their own routes; the rest ride the
// generic /api/integrations/:key connection routes (kind "integration").
export const CONNECTION_TYPES: ConnectionType[] = [
  {
    key: "github",
    name: "GitHub",
    description: "Repo access for agents — clone, read code, commit & open PRs via the Jungle GitHub App.",
    kind: "github",
  },
  {
    key: "google",
    name: "Gmail",
    description: "Agents read, search & send email from this Gmail account.",
    kind: "google",
  },
  ...INTEGRATION_TYPES.filter((t) => t.connection === "oauth" && !t.comingSoon).map(
    (t): ConnectionType => ({ key: t.key, name: t.name, description: t.description, kind: "integration" }),
  ),
];

export function getConnectionType(key: string): ConnectionType | undefined {
  return CONNECTION_TYPES.find((c) => c.key === key);
}

// The connection an integration is built on (e.g. gmail → the google connection).
export function connectionForIntegration(integrationKey: string): ConnectionType | undefined {
  const t = getIntegrationType(integrationKey);
  return t ? getConnectionType(t.connectionKey) : undefined;
}

export function getIntegrationType(key: string): IntegrationType | undefined {
  return INTEGRATION_TYPES.find((t) => t.key === key);
}

export function isKnownIntegration(key: string): boolean {
  return INTEGRATION_TYPES.some((t) => t.key === key);
}

// --- Settings-descriptor helpers (the single source of truth for per-workflow integration config) ---

// The settings an integration exposes (empty for read-only integrations).
export function settingsFor(key: string): IntegrationSettingField[] {
  return getIntegrationType(key)?.settings ?? [];
}

// Config keys that MUST be present for the integration to actually grant its tools (v1: github's
// repo). A github integration with no repo attaches silently but mints no git tools — the intake
// slot-fill and the web UI use this to prompt for the missing value instead of failing quietly.
export function requiredSettingKeys(key: string): string[] {
  return settingsFor(key)
    .filter((s): s is Extract<IntegrationSettingField, { required: true }> => "required" in s && s.required === true)
    .map((s) => s.key);
}

// The write-approval field for an integration, if any (gmail → requireSendApproval, other write
// integrations → requireApproval; read-only integrations → undefined). One place so the backend,
// the Liana web UI, and the main app's IntegrationsEditor can't drift on which key gates writes.
export function approvalFieldFor(key: string): Extract<IntegrationSettingField, { kind: "approval" }> | undefined {
  return settingsFor(key).find((s): s is Extract<IntegrationSettingField, { kind: "approval" }> => s.kind === "approval");
}

// Approval defaults ON: anything that isn't an explicit false means "ask me first".
export function approvalIsOn(value: unknown): boolean {
  return value !== false && value !== "false";
}

// The subset of a stored agent_integrations.config that is user-settable — strips internal keys
// (backingParticipantId, email, account) that back the connection but are never edited by hand.
// Used to build the wire shape the Liana web app and intake see.
export function filterToSettableKeys(key: string, config: Record<string, unknown>): Record<string, unknown> {
  const settable = new Set(settingsFor(key).map((s) => s.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (settable.has(k)) out[k] = v;
  }
  return out;
}

// One integration attached to a specific agent, as returned by GET /api/agents/:id/integrations.
export interface AgentIntegration {
  agent_id: string;
  integration_key: string;
  config: Record<string, unknown>;
}

// The `config` stored on an agent's `gmail` integration row. Holds NO secrets — the OAuth
// tokens live in the per-user google_identities table; this only records which connected
// account backs the agent ("creator mailbox") and how to gate writes. `backingParticipantId`
// is the human who attached it; `email` is that account's address (display); the backend mints
// access tokens from that participant's google_identities row at runtime (see backend/src/google.ts).
export interface GmailIntegrationConfig {
  backingParticipantId: string;
  email: string;
  requireSendApproval: boolean;
}

// The `config` stored on an agent's `x` integration row. Holds NO secrets — the OAuth 2.0 User
// Context tokens live in the per-user integration_connections table (key "x"). This only records
// which connected account backs the agent (the attaching user) and its @handle for display; the
// backend mints access tokens from that connection at runtime (see backend/src/integrations/x.ts).
export interface XIntegrationConfig {
  backingParticipantId: string;
  account: string; // the @handle of the connected account
}
