# Jungle agent-runner

A long-lived Node/TypeScript process that runs the Claude Agent SDK inside a
sandbox (one container per agent) and bridges it to the Jungle backend over a
single **outbound** WebSocket. The protocol is defined in
[`../docs/runner-protocol.md`](../docs/runner-protocol.md).

## What it does

- Dials out to `JUNGLE_BACKEND_WS?token=JUNGLE_RUNNER_TOKEN`, sends `hello`,
  receives `configure`.
- Queues `enqueue`d messages and feeds them to the SDK in **batches at turn
  boundaries** via streaming input.
- Forwards every SDK stream message verbatim as `event` frames.
- Exposes the `send_message` custom tool (in-process SDK MCP server `jungle`);
  the handler forwards a `send_message` frame and awaits `send_message_result`
  (60s timeout).
- Routes tool confirmations through `confirm_request` / `confirm_result`
  (`canUseTool`).
- Applies `set_permission_mode` immediately; applies `set_model` at the next
  turn boundary (ends the current `query()`, starts a new one with
  `resume: sessionId` and the new model).
- Reconnects with backoff and persists `sessionId` in
  `/workspace/.jungle/state.json` so agent memory survives restarts.

## Env

| var | meaning |
|---|---|
| `JUNGLE_BACKEND_WS` | backend WS base URL (`?token=` is appended) |
| `JUNGLE_RUNNER_TOKEN` | per-agent secret |
| `ANTHROPIC_API_KEY` | consumed by the SDK |
| `JUNGLE_AGENT_ID` | informational; sent in `hello` (default `unknown`) |
| `JUNGLE_WORKSPACE` | agent cwd (default `/workspace`; override for host testing) |
| `JUNGLE_STATE_DIR` | state dir (default `/workspace/.jungle`) |

## Build & run

```bash
npm install
npm run build      # sync protocol from shared, then tsc -> dist/
npm start          # node dist/index.js
```

`src/protocol.ts` is **generated** — `npm run build` first runs
`scripts/sync-protocol.mjs`, which copies the source of truth at
`../shared/src/runner-protocol.ts` (the backend imports the same types from
`@jungle/shared`). Edit the shared file, not `src/protocol.ts`. In an isolated
checkout without the workspace the sync is a no-op and the committed copy is
used, so the Docker build (which builds `dist/` outside the image) is unaffected.

## Docker

```bash
npm run build
sudo docker build -t jungle-runner:dev .
sudo docker run --rm \
  -e ANTHROPIC_API_KEY=... \
  -e JUNGLE_BACKEND_WS=ws://host:port/api/runner \
  -e JUNGLE_RUNNER_TOKEN=... \
  --add-host=host.docker.internal:host-gateway \
  -v <agent-volume>:/workspace \
  jungle-runner:dev
```

Runs as unprivileged user `agent`; the entrypoint fixes `/workspace` ownership
as root then drops privileges via `gosu`. Session transcripts and git creds live
under `/workspace` so memory survives container recreation.

## Testing

```bash
# terminal 1 — mock backend (scenarios: b, c, d, e-seed, e, f, full)
PORT=8790 JUNGLE_TOKEN=test-secret JUNGLE_SCENARIO=b npm run mock

# terminal 2 — runner on the host against the mock
JUNGLE_BACKEND_WS=ws://127.0.0.1:8790/api/runner bash test/run-host.sh
```

`test/run-host.sh` loads `ANTHROPIC_API_KEY` from the repo-root `.env` and points
`JUNGLE_WORKSPACE` at `/tmp/jungle-ws` so the SDK has a real cwd on the host.
