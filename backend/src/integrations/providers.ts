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

// Notion hosted MCP (https://developers.notion.com/guides/mcp). No scopes advertised → request
// none. Read tools search/fetch; write tools create/update pages & databases & comments.
export const notionAdapter = createMcpRemoteAdapter({
  key: "notion",
  displayName: "Notion",
  mcpUrl: "https://mcp.notion.com/mcp",
  toolsHint: "search and fetch pages/databases; create and update pages, databases and comments",
  safeTools: [
    "search", "fetch", "get-comments", "get-users", "get-user", "get-self", "get-teams",
    "notion-search", "notion-fetch", "notion-get-comments", "notion-get-users",
  ],
} satisfies McpAdapterSpec);

// Granola (https://docs.granola.ai/help-center/sharing/integrations/mcp). Read-only: query notes,
// meetings, transcripts and folders. `mcp` scope for the resource, `offline_access` for a refresh
// token. Everything is read-only → no approval needed.
export const granolaAdapter = createMcpRemoteAdapter({
  key: "granola",
  displayName: "Granola",
  mcpUrl: "https://mcp.granola.ai/mcp",
  scope: "mcp offline_access",
  readOnly: true,
  toolsHint: "search notes, list meetings and folders, read meeting transcripts",
  safeTools: [], // read-only → all tools allowed regardless
} satisfies McpAdapterSpec);
