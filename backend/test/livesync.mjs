// Live-update regression: the things the web app used to only learn about by being reloaded.
// Everything here rides the app WebSocket against a dev-bypass backend — no runner, no Anthropic.
//   1. application ping -> pong (the client's only liveness signal; without it a half-open
//      socket looks OPEN forever and the tab goes silent)
//   2. protocol-level ping from the server (the heartbeat that reaps dead sockets)
//   3. channel_created reaches a member who didn't create the channel
//   4. participant_created reaches everyone in the workspace when an agent is created
//   5. a message in a brand-new DM still fans out to the recipient (what makes the client
//      refetch a channel it has never seen)
//
// Run:  node test/livesync.mjs <backendPort>
// Assumes the backend is already running on that port with AUTH_DEV_BYPASS=1.
import WebSocket from "ws";

const PORT = process.argv[2] ?? "3021";
const API = `http://localhost:${PORT}/api`;
const SUFFIX = Date.now().toString(36).slice(-5);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function api(method, path, body, as) {
  const url = `${API}${path}${as ? (path.includes("?") ? "&" : "?") + `participantId=${as}` : ""}`;
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

// One socket per participant, collecting every frame it receives.
function connect(participantId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?participantId=${participantId}`);
  const seen = [];
  const waiters = [];
  let pinged = false; // did the SERVER send us a protocol-level ping?
  ws.on("ping", () => {
    pinged = true;
  });
  ws.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    seen.push(evt);
    for (const w of [...waiters]) {
      if (w.match(evt)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(evt);
      }
    }
  });
  const waitFor = (name, match, timeoutMs = 8000) => {
    const hit = seen.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
      waiters.push({ match, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  };
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  }).then(() => waitFor("connected", (e) => e.type === "connected"));
  return { ws, seen, waitFor, ready, sawServerPing: () => pinged };
}

const run = async () => {
  // Two humans in the dev default workspace, so "did the OTHER person see it?" is a real
  // question — every check here is about what a SECOND client learns without reloading.
  const alice = (await api("POST", "/participants", {
    kind: "human", handle: `alice${SUFFIX}`, displayName: "Alice",
  })).id;
  const bob = (await api("POST", "/participants", {
    kind: "human", handle: `bob${SUFFIX}`, displayName: "Bob",
  })).id;

  const A = connect(alice);
  await A.ready;
  const B = connect(bob);
  await B.ready;

  // 1. Application ping -> pong.
  A.ws.send(JSON.stringify({ type: "ping" }));
  try {
    await A.waitFor("pong", (e) => e.type === "pong", 5000);
    check("client ping is answered with pong", true);
  } catch (e) {
    check("client ping is answered with pong", false, String(e.message));
  }

  // A pong must not be mistaken for anything else — the client returns early on it.
  check(
    "pong frame carries nothing but its type",
    A.seen.filter((e) => e.type === "pong").every((e) => Object.keys(e).length === 1),
  );

  // 2. The server's own heartbeat. HEARTBEAT_MS is 25s, too long to block a test on, so just
  //    assert the socket is still healthy and note whether a ping landed inside the window.
  //    (Set LIVESYNC_WAIT_HEARTBEAT=1 to actually wait it out.)
  if (process.env.LIVESYNC_WAIT_HEARTBEAT === "1") {
    await new Promise((r) => setTimeout(r, 30_000));
    check("server sends a protocol-level ping within the heartbeat window", A.sawServerPing());
  }

  // 3. channel_created reaches a member who didn't create it.
  {
    const created = api("POST", "/channels", { name: `proj-${SUFFIX}`, memberHandles: [`bob${SUFFIX}`] }, alice);
    try {
      const evt = await B.waitFor("channel_created", (e) => e.type === "channel_created");
      const { id } = await created;
      check("channel_created reaches the other member", evt.channelId === id, `got ${evt.channelId}`);
    } catch (e) {
      check("channel_created reaches the other member", false, String(e.message));
      await created.catch(() => {});
    }
  }

  // 4. participant_created reaches everyone in the workspace, WITHOUT the runner token.
  const agentP = api(
    "POST",
    "/agents",
    { handle: `bot${SUFFIX}`, displayName: "Bot", runnerProvider: "docker" },
    alice,
  );
  try {
    const evt = await B.waitFor("participant_created", (e) => e.type === "participant_created", 15_000);
    check("participant_created announces the new agent", evt.participant?.handle === `bot${SUFFIX}`,
      `got @${evt.participant?.handle}`);
    check(
      "participant_created never carries the runner token",
      !("runner_token" in (evt.participant ?? {})) && !("claude_oauth_token" in (evt.participant ?? {})),
      JSON.stringify(Object.keys(evt.participant ?? {}).filter((k) => k.includes("token"))),
    );
  } catch (e) {
    check("participant_created announces the new agent", false, String(e.message));
  }
  const agent = await agentP.catch((e) => {
    console.log("  (agent create failed:", String(e.message).slice(0, 120), ")");
    return null;
  });

  // 5. The first message in a brand-new DM still reaches the recipient's socket. This is the
  //    frame the client used to drop on the floor because the channel wasn't in its sidebar.
  {
    const dm = await api("POST", "/dms", { otherId: bob }, alice);
    A.ws.send(JSON.stringify({ type: "post", channelId: dm.id, body: "first contact", clientMsgId: `m-${SUFFIX}` }));
    try {
      const evt = await B.waitFor("dm message", (e) => e.type === "message" && e.message?.channel_id === dm.id);
      check("the first message in a new DM fans out to the recipient", evt.message.body === "first contact");
      const after = await api("GET", "/channels", null, bob);
      check(
        "and the DM is in their channel list once refetched (what the client now does)",
        after.some((c) => c.id === dm.id),
      );
    } catch (e) {
      check("the first message in a new DM fans out to the recipient", false, String(e.message));
    }
  }

  // Cleanup: the agent row would otherwise hold a docker volume reference.
  if (agent?.id) await api("DELETE", `/agents/${agent.id}`, null, alice).catch(() => {});

  A.ws.close();
  B.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
