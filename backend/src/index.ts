import "./env";
import { createServer } from "node:http";
import * as db from "./db";
import * as runners from "./runners";
import * as hostcontrol from "./hostcontrol";
import * as att from "./attachments";
import { setProvisioner, provisionerFor } from "./provisioner";
import { FlyProvisioner } from "./provisioner-fly";
import { createApp } from "./app";
import { initAppSocket, broadcastUid } from "./ws/appSocket";
import { triggerMentionedAgents, buildRunnerHooks } from "./services/orchestrator";
import { startScheduler } from "./services/scheduler";
import { startWorkflowSweeper } from "./services/workflows";
import { startSlackOutbox } from "./services/slackBridge";
import * as telegram from "./services/telegram";
import * as liana from "./services/liana";
import { BACKEND_ORIGIN } from "./http/routes/liana";
import { registerBuiltinIntegrations } from "./integrations";

// Entry point / boot: wire the HTTP app, both WebSocket subsystems (app + runner), background
// jobs, and start listening. The request handlers live in http/routes/*, the realtime plumbing
// in ws/appSocket + runners, and the agent-cascade logic in services/orchestrator.

// Safety net: this backend is a shared relay for every user, so a stray rejection from one agent
// turn (e.g. a wedged session's "waiting on responses" 400) must not terminate the process. Log
// and keep serving instead of the Node default (crash on unhandled rejection).
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

// Register the Fly provisioner alongside the always-present 'docker' one (provisioner.ts).
setProvisioner("fly", new FlyProvisioner());

// Register the built-in integration adapters (github, gmail, …) so runners.ts / routes can
// dispatch by key (backend/src/integrations/).
registerBuiltinIntegrations();

const app = createApp();
const server = createServer(app);

// The app (human/device) WebSocket. After a human's message is persisted + fanned out, run any
// addressed agents (the cascade engine).
initAppSocket(server, { onMessagePosted: triggerMentionedAgents });

// The SDK runner subsystem: runners dial into /api/runner (its own upgrade listener). Wire the
// chat-side effects a runner needs (post messages, confirm cards, events, status) back in.
runners.init(server, buildRunnerHooks());

// The host-control subsystem: self-hosted devices' daemons dial into /api/host. When a device
// comes up/down, tell its owner's open Environments page (device_status_changed) and re-emit the
// status of every agent on it (they flip offline <-> sleeping/idle); on up, kick the sweeper so
// any agent with queued work starts without waiting for the next tick.
hostcontrol.init(server, {
  onHostStatusChange: (hostId, ownerUid, online) => {
    broadcastUid(ownerUid, { type: "device_status_changed", deviceId: hostId, online });
    void db
      .agentsOnHost(hostId)
      .then((agents) => {
        for (const a of agents) runners.refreshStatus(a.id);
        if (online) runners.kickSweep();
      })
      .catch((e) => console.error(`onHostStatusChange(${hostId}):`, e));
  },
});

// Hourly attachment GC: abandoned composer uploads (never linked to a message) and blobs whose
// rows were removed by FK cascades (deleted messages/channels/agents).
setInterval(() => void att.gcOrphans().catch((e) => console.error("attachment gc:", e)), 60 * 60 * 1000).unref();

// Boot reconciliation: seed each sdk agent's at-rest machine state (so the status dot doesn't
// default to "idle" for a machine the sweeper stopped before the last restart) and recreate any
// agent whose machine has vanished entirely (e.g. a Fly host reclaim). Fire-and-forget — the
// server shouldn't block startup on every agent's provider round-trip.
async function reconcileMachinesAtBoot(): Promise<void> {
  const agents = await db.listSdkAgents();
  for (const agent of agents) {
    try {
      const status = await provisionerFor(agent).status(agent.id);
      runners.reseedMachineState(agent.id, status);
      if (status === "absent") {
        if (!agent.runner_token) {
          console.error(`agent ${agent.id} missing runner_token — skip recreate`);
          continue;
        }
        console.error(`agent @${agent.handle} has no machine at boot — recreating`);
        await provisionerFor(agent).create({ id: agent.id, handle: agent.handle, runnerToken: agent.runner_token });
        await provisionerFor(agent).start(agent.id);
        runners.noteProvisionerStart(agent.id);
      }
    } catch (e) {
      console.error(`boot reconciliation failed for ${agent.id}:`, e);
    }
  }
}
void reconcileMachinesAtBoot();
runners.startIdleSweeper();
// Fire due scheduled turns (recurring/one-shot). Advances next_run_at before dispatch, so a
// crash mid-fire skips rather than double-fires.
startScheduler();
startWorkflowSweeper();
// Migrate any already-provisioned Liana conductors onto the current default model (e.g. the switch
// to Haiku). One-shot, best-effort; new conductors are created on the right model directly.
void liana.backfillLianaConductorModels().catch((e) => console.error("liana model backfill:", e));
// Drain the Slack mirror outbox (Jungle -> Slack). Enqueued transactionally in persistMessage.
startSlackOutbox();
// Register the Liana Telegram bot's webhook (idempotent; no-op when the bot isn't configured).
if (telegram.telegramConfigured()) {
  telegram.ensureWebhook(BACKEND_ORIGIN).catch((e) => console.error("telegram setWebhook failed:", e));
}

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => console.log(`jungle-backend on http://localhost:${PORT}`));
