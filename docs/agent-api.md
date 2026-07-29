# Jungle agent API: API tokens + the /mcp server

Everything a workspace member can do in Jungle is programmable. Two pieces make that work:

1. **Participant-scoped API tokens** (`api_tokens`, `backend/src/db/apiTokens.ts`) — a bearer
   token (`jgl_<hex>`) that acts AS a participant. `guards.requester()` resolves it exactly like
   a signed-in user, so the **entire existing REST API** accepts it, plus the MCP server below.
2. **The inbound MCP server** (`backend/src/mcp/`) — `POST /mcp` speaks MCP's Streamable HTTP
   transport (stateless JSON responses) and exposes the workspace as tools: messaging, channels,
   agents, workflows, schedules.

The same server serves two audiences:

- **External agents** (Claude Code, or anything MCP-capable) connect directly with a token.
- **In-Jungle agents** attach the **"Jungle" integration** (key `jungle-admin`,
  `backend/src/integrations/jungle.ts`): the backend mints an agent-bound token and mounts
  `/mcp` into the runner via the existing `mcpIntegrations` configure plumbing. Read-only tools
  are auto-allowed; mutating tools route through the normal confirmation card unless the
  integration's approval toggle is off.

## Tokens

Minting is **humans only** (Firebase-authed, or dev bypass) — a token holder can't mint itself
fresh credentials, so revocation means something.

```
POST   /api/tokens        { name, participantId? }   -> { id, token: "jgl_…", … }  (plaintext shown once)
GET    /api/tokens                                   -> { tokens: […] }            (workspace-scoped, no hashes)
DELETE /api/tokens/:id                               -> { ok: true }               (revokes immediately)
```

- Default: the token is bound to **you** — the caller acts as your participant.
- `participantId` naming an **agent in your workspace** binds the token to that agent instead:
  messages post under the agent's handle, workspace scoping follows the agent.
- Only the sha256 of the token is stored. `X-Workspace-Id` is ignored for token auth — the bound
  participant already fixes the workspace.
- The `jungle-admin` integration manages its own agent-bound token (name `jungle integration`),
  rotated on every runner configure and deleted on detach.

## Using the REST API with a token

Any route that goes through `requester()` works:

```bash
curl -H "Authorization: Bearer jgl_…" https://api.jungleagents.com/api/channels
```

## Using the MCP server

Endpoint: `POST /mcp` with `Authorization: Bearer jgl_…`. Stateless Streamable HTTP: JSON-RPC in,
`application/json` out; notifications get `202`; no sessions, no server-initiated streams (GET
returns 405, which spec-compliant clients tolerate).

Claude Code:

```bash
claude mcp add --transport http jungle https://api.jungleagents.com/mcp \
  --header "Authorization: Bearer jgl_…"
```

Tools (25; read-only ones are annotated `readOnlyHint` and listed in `SAFE_JUNGLE_TOOLS`):

| Area | Tools |
|---|---|
| Messaging | `send_message`, `read_history` |
| Channels & people | `list_channels`, `list_participants`, `create_channel`, `add_channel_member`, `remove_channel_member` |
| Connections | `list_connections` |
| Agents | `create_agent`, `get_agent`, `update_agent`, `delete_agent`, `attach_integration`, `detach_integration` |
| Workflows | `list_workflows`, `workflow_list_templates`, `workflow_draft_create`, `workflow_draft_get`, `workflow_draft_set`, `workflow_finalize`, `workflow_run`, `workflow_set_paused` |
| Schedules | `schedule_create`, `schedule_list`, `schedule_cancel` |

Semantics match the app: `#channel` sends require membership, `@handle` sends open/reuse the DM,
@mentions trigger agents (fresh cascade budget — a token-authed post is externally initiated,
like a human typing), workflow finalize creates real agents/channels/triggers.

### Attaching connection-based integrations as an agent

Gmail, Notion, Linear, Granola, Drive, Calendar and X are built on a **per-person** OAuth grant
(Settings → Connections). Attaching one binds the agent to one specific account —
`config.connectionId` (a row in `integration_connections`), or `config.backingParticipantId` for
gmail, whose account is a participant's Google identity. A person can hold several accounts for one
integration (two Notion workspaces, two X accounts), so `list_connections` lists them with their
owner and id.

An agent has no Settings page and can never hold a connection itself, so when the actor is an agent,
`attach_integration` / `create_agent` bind to the account of the person it's acting for
(`backend/src/integrations/backing.ts`), resolved in this order:

1. **`config.connectionId`** — one specific account, from `list_connections`. Must belong to
   someone in the agent's workspace.
2. **`onBehalfOf`** — `"@handle"` of the person whose account to use.
3. The **acting agent's own binding** for that same integration, if it has one.
4. The agent's **owner** — `participants.created_by`, walked up to the first human.
5. The **only person in the workspace** who has connected it.

Nothing ambiguous is ever picked silently: no candidate → "nobody in this workspace has connected X
yet" (a person must connect it first); several people → the error lists them and asks for
`onBehalfOf`; several accounts belonging to the chosen person → the error names them and asks for
`connectionId`. Humans are unaffected — they bind their own accounts, and passing `onBehalfOf` for
someone else is a 403.

`create_agent` is all-or-nothing: if an integration can't be resolved, the agent row is rolled back
rather than left existing-but-unprovisioned.

## Layering

Route handlers and MCP tools share one service layer, both taking an explicit actor participant:

- `services/directory.ts` — channels, membership, posting (`postMessageAs`, `createChannelAs`, …)
- `services/agentAdmin.ts` — agent lifecycle/config/integrations (`createAgentAs`, …)
- `services/workflows.ts`, `services/scheduler.ts` — already actor-shaped; reused as-is.

Adding a capability = one service function + a thin REST head + a `JUNGLE_TOOLS` entry
(`backend/src/mcp/tools.ts`).

## Verification

`backend/test/mcp-api.mjs` drives the whole surface end-to-end (mint → REST → MCP handshake →
channels/messaging/agents/schedules/workflow drafts → agent-bound token attribution → revocation):

```bash
set -a; . .env; set +a
node backend/test/mcp-api.mjs            # backend on :3001
BASE=http://localhost:3101 node backend/test/mcp-api.mjs
```

`backend/test/agent-attach-integration.mjs` covers the connection-backing rules above (agent
attaches with zero / one / several connected people, `onBehalfOf`, the human path, and the
all-or-nothing `create_agent` rollback) in a throwaway workspace:

```bash
set -a; . .env; set +a
node backend/test/agent-attach-integration.mjs
```
