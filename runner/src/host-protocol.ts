// GENERATED FILE — do not edit. Source of truth: shared/src/host-protocol.ts
// Regenerate with `npm run build` (runs scripts/sync-protocol.mjs) in the runner package.

// Jungle host-control protocol (v1). See docs/runner-protocol.md for the sibling per-agent
// protocol. This is the control channel between a user's `jungle-runner` DAEMON and the backend,
// used only for self-hosted agents (runner_provider = 'self_hosted').
//
// Direction & auth: the daemon dials OUT and holds ONE WebSocket per device:
//     ws(s)://<backend>/api/host?token=<DEVICE_TOKEN>
// The device token is account-scoped (minted by the device-code auth flow), NOT per-agent.
// Over this channel the backend tells the daemon which agents to run; the daemon spawns/kills a
// per-agent RUNNER child for each, and those children dial /api/runner exactly like cloud runners
// (runner-protocol.ts) using their own per-agent runner_token. This channel never carries turn
// traffic — only lifecycle.
//
// SOURCE OF TRUTH for the host wire contract. The backend imports from `@jungle/shared`; the
// standalone runner package gets a generated copy at `runner/src/host-protocol.ts` via
// `runner/scripts/sync-protocol.mjs` (like protocol.ts). Edit this file only.

export const HOST_PROTOCOL_VERSION = 1;

// ---- Daemon -> backend ----

// Sent on every (re)connect. `running` lets the backend reconcile: any agent it believes should
// run on this device but isn't listed gets a fresh `run_agent`; anything running that shouldn't
// be gets `stop_agent`/`remove_agent`.
export interface HostHelloFrame {
  type: "host_hello";
  protocol: 1;
  hostname: string;
  platform: string; // process.platform
  arch: string; // process.arch
  runnerVersion: string;
  running: string[]; // agentIds with a live runner child right now
}

// A per-agent runner child exited (crash, clean stop, or kill). The backend clears any "running"
// state for the agent; if the exit was unexpected and the agent has pending work, the idle-stop
// sweeper's reverse path will re-issue `run_agent`.
export interface RunnerExitedFrame {
  type: "runner_exited";
  agentId: string;
  code: number | null;
  signal?: string | null;
}

// Liveness keepalive (the WS ping/pong is transport-level; this is app-level so the backend can
// stamp last_seen_at without depending on ping frames surviving proxies).
export interface HostHeartbeatFrame {
  type: "host_heartbeat";
}

export type HostToBackend = HostHelloFrame | RunnerExitedFrame | HostHeartbeatFrame;

// ---- Backend -> daemon ----

// Ensure a runner child is running for this agent with these params (idempotent: if it's already
// running with the same token, no-op). Carries everything the daemon needs to spawn the child, so
// it survives a daemon restart with no server-side per-daemon session state. `runnerToken` is the
// agent's per-agent secret (also used as the LLM-proxy key); `llmBaseUrl` points the child's SDK
// at the backend inference proxy so no real API key ever reaches the device.
export interface RunAgentFrame {
  type: "run_agent";
  agentId: string;
  handle: string; // for the daemon's per-agent dir naming + logs
  runnerToken: string;
  backendWs: string; // wss://…/api/runner base (child appends ?token=)
  llmBaseUrl: string; // https://…/api/llm (child's ANTHROPIC_BASE_URL)
}

// Stop the agent's runner child but KEEP its workspace/state on disk (idle-stop / sleep). The
// agent can be woken later with another `run_agent`, resuming its session.
export interface StopAgentFrame {
  type: "stop_agent";
  agentId: string;
}

// Stop the child AND delete the agent's workspace/state on disk (agent deleted or reassigned to a
// different device). Full local teardown.
export interface RemoveAgentFrame {
  type: "remove_agent";
  agentId: string;
}

export type BackendToHost = RunAgentFrame | StopAgentFrame | RemoveAgentFrame;
