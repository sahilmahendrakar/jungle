// Mock Jungle backend for testing the runner. Plain-node `ws` server.
// - Accepts the runner connection, checks ?token=
// - Replies to `hello` with `configure` (cheap model, default mode)
// - Logs all frames
// - Auto-replies send_message_result {ok:true} and confirm_result allow
// - Scripted scenario driven by env JUNGLE_SCENARIO (a|b|c|d|e|f) or default runs a full sequence
//
// Usage: PORT=8790 JUNGLE_TOKEN=secret node test/mock-backend.mjs
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8790);
const EXPECTED_TOKEN = process.env.JUNGLE_TOKEN ?? "test-token";
const SCENARIO = process.env.JUNGLE_SCENARIO ?? "full";
const MODEL = process.env.JUNGLE_MODEL ?? "claude-haiku-4-5";

const wss = new WebSocketServer({ port: PORT });
console.error(`[mock] listening on ws://0.0.0.0:${PORT}/api/runner  scenario=${SCENARIO} model=${MODEL}`);

let connCount = 0;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  connCount++;
  const thisConn = connCount;
  if (token !== EXPECTED_TOKEN) {
    console.error(`[mock] REJECT connection #${thisConn}: bad token`);
    ws.close(4001, "bad token");
    return;
  }
  console.error(`[mock] connection #${thisConn} accepted`);

  const send = (frame) => {
    console.error(`[mock] -> ${frame.type} ${summarize(frame)}`);
    ws.send(JSON.stringify(frame));
  };

  const enqueue = (text) =>
    send({ type: "enqueue", items: [{ inboxId: randomUUID(), text }] });

  let sawConfirmForBash = false;
  let sawSendToGeneral = false;
  let turnsDone = 0;
  let sessionIdSeen = null;

  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      console.error(`[mock] <- unparseable: ${data}`);
      return;
    }
    logIncoming(frame);

    switch (frame.type) {
      case "hello": {
        sessionIdSeen = frame.sessionId;
        console.error(`[mock] HELLO agentId=${frame.agentId} sessionId=${frame.sessionId} protocol=${frame.protocol}`);
        send({
          type: "configure",
          model: MODEL,
          permissionMode: "default",
          systemPromptAppend: "You are test-runner in Jungle.",
        });
        // Kick off scenario after configure settles.
        setTimeout(() => runScenario(thisConn, frame.sessionId), 800);
        break;
      }
      case "send_message": {
        if (frame.input?.to === "#general") sawSendToGeneral = true;
        // auto-ack
        send({ type: "send_message_result", id: frame.id, result: { ok: true, messageId: "msg_" + randomUUID().slice(0, 8) } });
        break;
      }
      case "confirm_request": {
        if (frame.toolName === "Bash") sawConfirmForBash = true;
        console.error(`[mock] CONFIRM ${frame.toolName} input=${JSON.stringify(frame.input).slice(0, 200)} -> ALLOW`);
        send({ type: "confirm_result", id: frame.id, result: "allow" });
        break;
      }
      case "turn_done": {
        turnsDone++;
        console.error(`[mock] TURN_DONE #${turnsDone} ok=${frame.ok} error=${frame.error ?? ""}`);
        break;
      }
      case "event": {
        // Surface assistant text and result so scenario (e) memory check is visible.
        const ev = frame.event;
        if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b.type === "text") console.error(`[mock]   [assistant text] ${b.text.slice(0, 300)}`);
            if (b.type === "tool_use") console.error(`[mock]   [tool_use] ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`);
          }
        }
        if (ev?.type === "result") {
          console.error(`[mock]   [result] subtype=${ev.subtype} model=${JSON.stringify(ev.modelUsage ? Object.keys(ev.modelUsage) : [])} session=${ev.session_id}`);
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => console.error(`[mock] connection #${thisConn} closed (sawSendToGeneral=${sawSendToGeneral} sawConfirmForBash=${sawConfirmForBash} turnsDone=${turnsDone})`));

  function runScenario(connNum, sessionId) {
    switch (SCENARIO) {
      case "b":
        enqueue('Say hi in #general via the send_message tool. Use to:"#general".');
        break;
      case "c":
        enqueue("Run the shell command `echo hello` using the Bash tool.");
        break;
      case "d":
        enqueue("First task: reply with the number 1 in #general via send_message.");
        enqueue("Second task: reply with the number 2 in #general via send_message.");
        break;
      case "e-seed":
        // Establish a memorable first instruction, then let the process be killed.
        enqueue(
          'Remember this: my favorite color is chartreuse. Acknowledge in #general via send_message.',
        );
        break;
      case "e":
        // On restart against a persisted session, ask a memory question.
        enqueue(
          "What color did I tell you was my favorite earlier? Answer in #general via send_message.",
        );
        break;
      case "f":
        setTimeout(() => send({ type: "set_model", model: "claude-sonnet-4-6" }), 100);
        setTimeout(() => enqueue("Reply 'model switched' in #general via send_message."), 400);
        break;
      case "full":
      default:
        // Run b, then c, then d sequentially with delays.
        enqueue('Say hi in #general via the send_message tool. Use to:"#general".');
        setTimeout(() => enqueue("Run the shell command `echo hello` using the Bash tool."), 6000);
        setTimeout(() => {
          enqueue("Rapid task A: say A in #general via send_message.");
          enqueue("Rapid task B: say B in #general via send_message.");
        }, 14000);
        setTimeout(() => {
          console.error("[mock] full scenario complete, closing in 3s");
          setTimeout(() => process.exit(0), 3000);
        }, 24000);
        break;
    }
  }
});

function logIncoming(frame) {
  if (frame.type === "event") return; // handled separately, too noisy
  console.error(`[mock] <- ${frame.type} ${summarize(frame)}`);
}

function summarize(frame) {
  switch (frame.type) {
    case "state":
      return `state=${frame.state} model=${frame.model} mode=${frame.permissionMode} session=${frame.sessionId}`;
    case "turn_started":
      return `turnId=${frame.turnId.slice(0, 8)} inbox=${frame.inboxIds.length}`;
    case "consumed":
      return `inbox=${frame.inboxIds.length}`;
    case "send_message":
      return `to=${frame.input?.to} body=${JSON.stringify(frame.input?.body)?.slice(0, 80)}`;
    case "confirm_request":
      return `tool=${frame.toolName}`;
    case "configure":
      return `model=${frame.model} mode=${frame.permissionMode}`;
    case "enqueue":
      return `items=${frame.items.length}`;
    case "set_model":
      return `model=${frame.model}`;
    default:
      return "";
  }
}
