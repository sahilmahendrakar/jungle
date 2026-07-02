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
| `send_message` | `id`, `input: {to, body}` | the agent's custom tool call; backend posts the chat message and replies `send_message_result` |
| `confirm_request` | `id`, `toolName`, `input`, `suggestions?` | `canUseTool` fired; backend surfaces the confirmation card and replies `confirm_result` |
| `turn_done` | `turnId`, `ok: boolean`, `error?` | turn finished; backend may immediately `enqueue` more |
| `fatal` | `error` | unrecoverable runner error (backend should surface + restart container) |

## Backend → runner frames

| type | fields | meaning |
|---|---|---|
| `configure` | `model`, `permissionMode`, `systemPromptAppend`, `git?: {token, login}` | reply to `hello`; also sent when config changes while idle |
| `enqueue` | `items: [{inboxId, text}]` | text is fully composed by the backend (sender/channel context included). Runner queues; consumed at next turn boundary |
| `interrupt` | — | `q.interrupt()` the running turn |
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
`allowedTools: ["mcp__jungle__send_message"]`. Schema matches the MA version:
`{to: "#channel"|"@handle", body: string}`. It is the agent's only way to speak;
plain assistant text is never shown to users.

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
