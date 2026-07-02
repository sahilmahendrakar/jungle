// fake-runner.mjs — a stand-in for the real runner container (built in parallel), to exercise
// the backend's /api/runner protocol end (docs/runner-protocol.md) without the Agent SDK.
//
// It connects to /api/runner?token=<RUNNER_TOKEN>, sends `hello`, prints every frame it
// receives, and can play a small script of runner->backend frames. Use it to watch a backend
// dispatch land as `enqueue`, then reply `consumed` + `send_message` + `turn_done`, and to
// drive a `confirm_request` round-trip.
//
// Usage:
//   node backend/test/fake-runner.mjs --token <RUNNER_TOKEN> [--ws ws://localhost:3001] [--script auto]
//
// --script auto: on the first `enqueue`, ack it (turn_started + consumed), send one
//   send_message back into Jungle, then turn_done. Otherwise it just prints frames and you can
//   type JSON frames on stdin (one per line) to send them manually.

import { WebSocket } from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const TOKEN = args.token || process.env.JUNGLE_RUNNER_TOKEN;
const WS = args.ws || process.env.JUNGLE_BACKEND_WS?.replace(/\/api\/runner.*/, "") || "ws://localhost:3001";
const SCRIPT = args.script || "manual";
// For --script auto: where to send the reply message, and its body.
const REPLY_TO = args.to || null; // e.g. "#general" or "@sahil"
const REPLY_BODY = args.body || "hello from the fake runner";

if (!TOKEN) {
  console.error("need --token <RUNNER_TOKEN> (or JUNGLE_RUNNER_TOKEN)");
  process.exit(2);
}

const url = `${WS}/api/runner?token=${encodeURIComponent(TOKEN)}`;
console.log("connecting:", url, "script:", SCRIPT);
const ws = new WebSocket(url);

const sessionId = `fake-sess-${Date.now().toString(36)}`;
let turnCounter = 0;

const sendFrame = (obj) => {
  console.log("→ send:", JSON.stringify(obj));
  ws.send(JSON.stringify(obj));
};

ws.on("open", () => {
  console.log("open — sending hello");
  sendFrame({ type: "hello", agentId: "unknown-to-runner", sessionId, protocol: 1 });
});

ws.on("close", (code, reason) => {
  console.log("closed:", code, reason?.toString());
  process.exit(0);
});
ws.on("error", (e) => console.error("ws error:", e.message));

ws.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    console.log("← non-JSON:", raw.toString());
    return;
  }
  console.log("← recv:", JSON.stringify(frame));

  if (SCRIPT !== "auto") return;

  if (frame.type === "configure") {
    console.log("   (configured) model=%s mode=%s git=%s", frame.model, frame.permissionMode, !!frame.git);
    sendFrame({ type: "state", state: "idle", sessionId, model: frame.model, permissionMode: frame.permissionMode });
  }

  if (frame.type === "enqueue") {
    const inboxIds = (frame.items || []).map((i) => i.inboxId);
    const turnId = `turn-${++turnCounter}`;
    console.log("   (enqueue) items:", frame.items?.map((i) => i.text?.slice(0, 60)));
    sendFrame({ type: "turn_started", turnId, inboxIds });
    sendFrame({ type: "consumed", inboxIds, turnId });
    // Emit a fake SDK stream event (backend should persist + broadcast agent_event).
    sendFrame({ type: "event", turnId, event: { type: "assistant", text: "(thinking…)" } });
    // Speak back into Jungle. If no explicit --to, try to reply into the first #channel the
    // enqueued text mentions ("in #name"), else fall back to REPLY_TO.
    let to = REPLY_TO;
    if (!to) {
      const m = (frame.items?.[0]?.text || "").match(/#([a-z0-9_-]+)/i);
      if (m) to = `#${m[1]}`;
    }
    if (to) {
      sendFrame({ type: "send_message", id: `sm-${turnId}`, input: { to, body: REPLY_BODY } });
    } else {
      console.log("   (no destination inferred — skipping send_message)");
    }
    // Give the backend a moment, then finish the turn.
    setTimeout(() => sendFrame({ type: "turn_done", turnId, ok: true }), 800);
  }

  if (frame.type === "send_message_result") {
    console.log("   (send_message_result)", JSON.stringify(frame.result));
  }

  if (frame.type === "confirm_result") {
    console.log("   (confirm_result)", frame.result, frame.denyMessage ?? "");
  }
});

// Manual mode: read JSON frames from stdin, one per line, and forward them.
if (SCRIPT === "manual") {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        sendFrame(JSON.parse(line));
      } catch (e) {
        console.error("bad JSON on stdin:", e.message);
      }
    }
  });
}
