import { createMcpRemoteAdapter, type McpAdapterSpec } from "./mcp-remote";

// Analytics integrations: PostHog + Mixpanel via their OFFICIAL hosted MCP servers, connected
// with spec-compliant MCP OAuth (discovery + DCR + PKCE + refresh tokens — verified live
// 2026-07-21 against both providers' well-known metadata). Same machinery as Linear/Notion/
// Granola (mcp-oauth.ts); PostHog's authorization server lives on a separate origin
// (oauth.posthog.com) reached through the RFC 9728 protected-resource indirection, which
// discover() already follows.
//
// Both are readOnly by scope AND by policy: the requested scopes are the read-only slices of
// each provider's taxonomy, so even a confused agent can't mutate dashboards or flags — the
// grant itself forbids it. That also means no approval prompts to block scheduled runs.

// PostHog (https://posthog.com/docs/model-context-protocol): granular per-resource read scopes.
export const posthogAdapter = createMcpRemoteAdapter({
  key: "posthog",
  displayName: "PostHog",
  mcpUrl: "https://mcp.posthog.com/mcp",
  scope:
    "openid query:read insight:read dashboard:read event_definition:read property_definition:read " +
    "person:read project:read organization:read session_recording:read error_tracking:read " +
    "experiment:read feature_flag:read web_analytics:read metrics:read cohort:read survey:read",
  readOnly: true,
  toolsHint: "query events, insights, trends, funnels, errors, session data and docs",
  safeTools: [], // read-only → all tools allowed regardless
} satisfies McpAdapterSpec);

// Mixpanel (https://docs.mixpanel.com/docs/mcp): coarse read scopes; experiments/feature-flag
// write surfaces deliberately not requested. Note: the hosted MCP endpoint is region-family
// (mcp-eu / mcp-in exist for those data residencies) — OAuth connect targets the US host; EU/IN
// orgs would need the regional endpoint (revisit if one shows up).
export const mixpanelAdapter = createMcpRemoteAdapter({
  key: "mixpanel",
  displayName: "Mixpanel",
  mcpUrl: "https://mcp.mixpanel.com/mcp",
  scope:
    "projects analysis events insights segmentation retention data:read funnels flows " +
    "data_definitions business_context cohorts dashboard_reports metrics user_details",
  readOnly: true,
  toolsHint: "run queries and reports, inspect events/properties, read dashboards and metrics",
  safeTools: [], // read-only → all tools allowed regardless
} satisfies McpAdapterSpec);
