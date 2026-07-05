import { createMcpRemoteAdapter, type McpAdapterSpec } from "./mcp-remote";

// Specs for the remote-MCP integrations. Adding one is a spec here + a register call in index.ts;
// all the OAuth/mounting machinery is shared (mcp-oauth.ts, mcp-remote.ts, runner.ts).
//
// safeTools are the READ-ONLY tools auto-approved without a confirmation card. Err toward a SHORT
// list: a read tool left off just prompts for approval (harmless); a write tool wrongly included
// would auto-run. Names are seeded from each provider's docs and can be tightened after watching
// the tool inventory the runner logs at first connect (see runner init `mcp_servers`).

// Linear (https://linear.app/docs/mcp) — 25+ tools over issues/projects/comments/docs.
export const linearAdapter = createMcpRemoteAdapter({
  key: "linear",
  displayName: "Linear",
  mcpUrl: "https://mcp.linear.app/mcp",
  scope: "read write",
  toolsHint: "search/read issues, projects, comments and docs; create and update issues",
  safeTools: [
    "list_issues", "get_issue", "list_my_issues", "list_comments",
    "list_projects", "get_project", "list_project_labels",
    "list_teams", "get_team", "list_users", "get_user",
    "list_documents", "get_document", "search_documentation",
    "list_cycles", "list_issue_statuses", "get_issue_status", "list_issue_labels",
  ],
} satisfies McpAdapterSpec);
