# Jungle agent-runner protocol (v1)

The **runner** is a per-agent process running the Claude Agent SDK inside a sandbox
(Docker container today; Cloudflare/Vercel sandbox later). The **backend** is the
existing Node relay on EC2.

**Direction: the runner dials OUT to the backend** and holds one WebSocket:

```
ws(s)://<backend>/api/runner?token=<RUNNER_TOKEN>
```

`RUNNER_TOKEN` is a per-agent secret minted by the backend at agent creation
(`participants.runner_token`). Outbound-only connectivity is what makes the runner
portable: a cloud sandbox can always dial out; inbound routing differs per provider.
The backend must never need to reach *into* the sandbox.

All frames are JSON text messages. `id` fields are opaque strings chosen by the sender
of the request; responses echo them.

## Lifecycle

1. Runner boots with env: `JUNGLE_BACKEND_WS`, `JUNGLE_RUNNER_TOKEN`, `ANTHROPIC_API_KEY`.
   Workspace is `/workspace` (persistent volume). Session transcripts live under
   `/workspace/.jungle/` (`CLAUDE_CONFIG_DIR`-style dirs must stay inside the volume so
   the agent's memory survives container recreation).
2. Runner connects, sends `hello`. Backend replies `configure`. Runner is then `idle`.
3. Backend pushes `enqueue` frames; runner batches everything queued at each **turn
   boundary** into one SDK turn (streaming-input `query()`); user-visible semantics:
   queued messages and model changes apply at the next turn boundary; permission-mode
   changes apply immediately; `interrupt` cuts into a running turn.
4. On disconnect the runner finishes its current turn (tool calls that need
   confirmation are denied with "backend unreachable" rather than left hanging),
   keeps state on disk, and reconnects with backoff. The backend re-sends
   any inbox items not yet acked by `consumed`.

## Runner → backend frames

| type | fields | meaning |
|---|---|---|
| `hello` | `agentId`, `sessionId` (string\|null), `protocol: 1` | sent on every (re)connect |
| `state` | `state: "idle"\|"running"`, `sessionId`, `model`, `permissionMode` | sent whenever any of these change |
| `turn_started` | `turnId`, `inboxIds: string[]` | a turn began consuming these inbox items |
| `consumed` | `inboxIds: string[]` | the SDK has durably received these items (backend marks delivered) |
| `event` | `turnId`, `event: <SDK message JSON>` | every SDK stream message, verbatim (system/assistant/user/result + tool blocks). Backend persists for the Activity feed |
| `send_message` | `id`, `input: {to, body, attachmentIds?, threadRootId?, alsoToChannel?}` | the agent's custom tool call; backend posts the chat message and replies `send_message_result`. `attachmentIds` reference uploads the runner already made via `POST /api/attachments` (see Attachments). `threadRootId` replies into a thread (omitted → backend defaults to the thread the agent was triggered in; pass `null` to force top-level); `alsoToChannel` echoes a thread reply into the main channel timeline |
| `confirm_request` | `id`, `toolName`, `input`, `suggestions?` | `canUseTool` fired; backend surfaces the confirmation card and replies `confirm_result` |
| `turn_done` | `turnId`, `ok: boolean`, `error?` | turn finished; backend may immediately `enqueue` more. On `ok: false` the backend posts a crash notice from the agent into its last dispatch channel |
| `context_usage` | `tokens`, `maxTokens`, `percent` | context-window occupancy after a turn (SDK `getContextUsage()`, falling back to the result message's usage). Backend persists it on the participant row and broadcasts `agent_context` to app sockets |
| `fatal` | `error` | unrecoverable runner error (backend should surface + restart container) |

## Backend → runner frames

| type | fields | meaning |
|---|---|---|
| `configure` | `model`, `permissionMode`, `systemPromptAppend`, `git?: {token, login, repoUrl?}` | reply to `hello`; also sent when config changes while idle. When `repoUrl` is set the runner clones it to `/workspace/repo` (skip if present) BEFORE starting any turn |
| `enqueue` | `items: [{inboxId, text, attachments?}]` | text is fully composed by the backend (sender/channel context included). `attachments: [{url, filename, mime, sizeBytes?}]` are files on the triggering message: `url` is an origin-relative signed path the runner downloads into `/workspace/attachments/` (URLs are signed fresh at drain time). Runner queues; consumed at next turn boundary |
| `interrupt` | — | `q.interrupt()` the running turn |
| `compact` | — | ask the agent to compact/summarize its session context. Runs as a dedicated `/compact` turn when the agent is next idle (never interleaves with queued messages; repeat requests coalesce) |
| `set_permission_mode` | `mode` | applied immediately via `setPermissionMode()` |
| `set_model` | `model` | stored; applied at next turn boundary (query restart with `resume`) |
| `send_message_result` | `id`, `result: {ok, error?, messageId?}` | resolves the custom tool call |
| `confirm_result` | `id`, `result: "allow"\|"deny"`, `denyMessage?`, `updatedInput?` | resolves `canUseTool` |
| `git_credentials` | `token`, `login` | refreshed GitHub installation token (~1h TTL); runner rewrites its git credential store / `GH_TOKEN` |

## Permission modes

Wire values are the SDK's: `default`, `acceptEdits`, `plan`, `bypassPermissions`,
`dontAsk` (TS-only `auto` deferred). Jungle's legacy `always_allow` maps to
`bypassPermissions`, `always_ask` to `default`.

## send_message tool

Registered in the runner as an in-process SDK MCP server (`createSdkMcpServer`),
server name `jungle`, tool `send_message` — auto-allowed via
`allowedTools: ["mcp__jungle__send_message"]`. Schema:
`{to: "#channel"|"@handle", body: string, files?: string[], threadRootId?: string | null,
alsoToChannel?: boolean}`. It is the agent's only way to speak; plain assistant text is
never shown to users. `files` are workspace paths (max 10 × 25MB); the runner uploads
each via `POST /api/attachments` before sending the frame with the resulting
`attachmentIds`. `threadRootId`/`alsoToChannel` are the thread controls (see the
`send_message` frame row above); agents normally omit them and let the backend thread
replies automatically. Passing `threadRootId: null` explicitly (vs. omitting the field)
forces a top-level post even when the agent was addressed inside a thread.

## Attachments (HTTP, not WS)

File bytes never ride the runner WebSocket — they go over the backend's HTTP API,
reusing the same reachability assumption (runner dials out to the backend origin):

- **Download** (files people attached): each `enqueue` item may carry `attachments`
  with origin-relative signed URLs (`/api/attachments/<id>?e=<expiry>&sig=<hmac>`);
  the runner prefixes the origin derived from `JUNGLE_BACKEND_WS`, saves the bytes to
  `/workspace/attachments/<inboxId-prefix>/<filename>`, notes the paths in the turn
  text, and additionally passes allowlisted images ≤3.5MB as image content blocks so
  the model can see them.
- **Upload** (files the agent sends): `POST <origin>/api/attachments?filename=&mime=`
  with header `x-runner-token: <RUNNER_TOKEN>` and raw bytes as the body → `{id, …}`,
  then referenced as `attachmentIds` in `send_message`.

## Provisioner seam (backend-side)

```ts
interface Provisioner {
  create(agent: {id, handle, runnerToken}): Promise<void>; // image/volume/home
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  destroy(agentId: string): Promise<void>;   // includes volume
  status(agentId: string): Promise<"running"|"stopped"|"absent">;
}
```

The Docker implementation shells out to `docker`. A future Cloudflare implementation
talks to a thin Worker that boots the same image; the runner protocol is unchanged.
