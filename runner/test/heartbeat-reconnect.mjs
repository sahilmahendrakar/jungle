// Regression test for the half-open backend socket that strands an agent in "waking" forever.
//
// A TCP proxy sits between the runner's Connection and a real ws server. Mid-connection we
// blackhole the flow in BOTH directions without closing either leg — the faithful shape of a
// backend restart or an idle NAT/proxy reap: no FIN, no RST, so the client's socket sits at
// readyState OPEN and `close` never fires on its own. Only the heartbeat can notice.
//
// Before the heartbeat existed this hung forever: the runner never re-dialled, the backend's
// wake path no-opped against an already-started machine, and the agent was unreachable until
// its machine was manually restarted.
//
// Run: node test/heartbeat-reconnect.mjs   (after `npm run build`)
import net from "node:net";
import { WebSocketServer } from "ws";
import { Connection } from "../dist/connection.js";

const SERVER_PORT = 18771;
const PROXY_PORT = 18772;
// Two heartbeat intervals (probe, then reap on the unanswered next probe) plus slack.
const DETECT_BUDGET_MS = 70_000;

let connectionCount = 0;
const wss = new WebSocketServer({ port: SERVER_PORT });
wss.on("connection", () => {
  connectionCount++;
  console.log(`[server] runner connection #${connectionCount}`);
});

// The blackhole applies ONLY to the first proxied connection — the reconnect must be allowed
// through, otherwise we'd only be testing that the proxy stays broken.
let blackhole = false;
let proxied = 0;
const proxy = net.createServer((client) => {
  const mine = ++proxied;
  const dead = () => blackhole && mine === 1;
  const upstream = net.connect(SERVER_PORT, "127.0.0.1");
  client.on("data", (d) => {
    if (!dead()) upstream.write(d);
  });
  upstream.on("data", (d) => {
    if (!dead()) client.write(d);
  });
  const drop = () => {
    if (!dead()) client.destroy();
    upstream.destroy();
  };
  client.on("error", drop);
  upstream.on("error", drop);
  client.on("close", () => upstream.destroy());
});
proxy.listen(PROXY_PORT);

const conn = new Connection(`ws://127.0.0.1:${PROXY_PORT}/api/runner`, "test-token", {
  onFrame: () => {},
  onOpen: () => console.log("[runner] open"),
  onClose: () => console.log("[runner] close"),
});
conn.start();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(1000);
if (connectionCount !== 1) throw new Error(`expected 1 connection, got ${connectionCount}`);

console.log("[test] blackholing the connection (half-open: no FIN, no RST)...");
blackhole = true;
console.log(`[test] runner still believes socket is open: ${conn.isOpen}`);

console.log(`[test] waiting up to ${DETECT_BUDGET_MS / 1000}s for detect + reconnect...`);
const deadline = Date.now() + DETECT_BUDGET_MS;
while (Date.now() < deadline && connectionCount < 2) await sleep(1000);

const passed = connectionCount >= 2;
console.log(
  passed
    ? `\nPASS: runner detected the dead socket and reconnected (connections=${connectionCount})`
    : `\nFAIL: runner never reconnected (connections=${connectionCount}) — still stranded`,
);
conn.close();
proxy.close();
wss.close();
process.exit(passed ? 0 : 1);
