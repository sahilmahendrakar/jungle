// Regression test for the wedge that left an agent stuck "working" forever.
//
// Prod, 2026-07-31 (@outreach-agent): a turn's `result` arrived at 18:05:25, the close rule ran,
// and nothing happened. Two messages queued behind it at 18:06 and 18:07 were never delivered, the
// stop button did nothing, and the agent sat "working" until its machine was restarted by hand.
//
// Why: the runner has three ways to end a turn — the close rule at `result`, the quiescence window,
// and a model change — and ALL THREE funnel through endTurn(), which opened with
//
//     if (!this.batchResolver) return;
//
// batchResolver is only set while the input generator is parked at its await; it is null in the
// window between the generator being resolved and reaching that await again. A close landing in
// that window was DROPPED, on the reasoning that "the close rule re-fires at the next result".
// It doesn't when that result was the session's last event: stdin stays open, the CLI subprocess
// never exits, `running` never clears, and every later enqueue just grows a queue nobody reads.
// Three defenses, one shared precondition — so really one defense, and it had a hole.
//
// The fix makes the close intent STICKY: endTurn() records it even when it can't act, and the
// generator re-checks at its await point — mirroring what it already did for items that raced the
// same window. This test drives the real generator through that exact interleaving.
//
// Run: node test/stuck-turn-close.mjs   (after `npm run build`)
import { WebSocketServer } from "ws";
import { Runner } from "../dist/runner.js";

const PORT = 18781;
// A close that is dropped hangs forever; anything above the runner's own timers is enough to tell
// "returned promptly" from "never returns". Kept short so a failure fails fast.
const RETURN_BUDGET_MS = 3_000;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => ws.on("message", () => {}));

const runner = new Runner({
  wsUrl: `ws://127.0.0.1:${PORT}/api/runner`,
  token: "test-token",
  agentId: "test-agent",
  workspace: "/tmp",
});

// Resolves to "returned" / "yielded" rather than hanging, so a dropped close shows up as a timeout
// instead of an unresolved promise that stalls the whole run.
const nextOr = (gen, label) =>
  Promise.race([
    gen.next().then((r) => (r.done ? "returned" : "yielded")),
    new Promise((r) => setTimeout(() => r(`HUNG (${label})`), RETURN_BUDGET_MS)),
  ]);

const item = (id) => ({ inboxId: id, text: `message ${id}` });

// --- 1. the exact prod interleaving: close arrives while batchResolver is null ------------------
{
  const gen = runner.makeInputGenerator([item("a")], "turn-1");
  // The generator has not been advanced, so batchResolver is null — the same state it is in
  // between being resolved and re-parking, which is where the prod close landed.
  runner.endTurn();
  check("first batch still yields after a dropped-window close", (await nextOr(gen, "first yield")) === "yielded");
  const second = await nextOr(gen, "close");
  check(
    "the generator returns instead of hanging — the wedge",
    second === "returned",
    second.startsWith("HUNG") ? "endTurn() was dropped; stdin would stay open forever" : "",
  );
}

// --- 2. a close that arrives while the generator IS parked (the path that always worked) --------
{
  const gen = runner.makeInputGenerator([item("b")], "turn-2");
  check("first batch yields", (await nextOr(gen, "first yield")) === "yielded");
  const pending = nextOr(gen, "parked close");
  await new Promise((r) => setImmediate(r)); // let the generator reach its await
  runner.endTurn();
  check("a close lands normally when the generator is parked", (await pending) === "returned");
}

// --- 3. a close must not swallow work that belongs to the NEXT turn ----------------------------
{
  const gen = runner.makeInputGenerator([item("c")], "turn-3");
  await nextOr(gen, "first yield");
  runner.queue = [item("d")];
  runner.endTurn();
  const after = await nextOr(gen, "close with queue");
  check("a queued item does not resurrect a closed turn", after === "returned");
  check(
    "…and it stays queued for the next turn rather than being dropped",
    runner.queue.length === 1 && runner.queue[0].inboxId === "d",
    `queue=${JSON.stringify(runner.queue.map((q) => q.inboxId))}`,
  );
}

// --- 4. the close flag must not leak across turns ------------------------------------------------
{
  // runTurn resets closeRequested at the top and drains the queue into the first batch; simulate
  // that boundary so this case tests the flag alone, and confirm a fresh generator is not born
  // already-closed (which would end every subsequent turn after its first message).
  runner.closeRequested = false;
  runner.queue = [];
  const gen = runner.makeInputGenerator([item("e")], "turn-4");
  check("a fresh turn yields its first batch", (await nextOr(gen, "fresh yield")) === "yielded");
  // Still parked = the promise has NOT settled on its own. Race it against a short timer: if a
  // stale closeRequested had leaked in, the generator would have returned immediately instead.
  const parked = gen.next();
  const settled = await Promise.race([
    parked.then(() => "settled"),
    new Promise((r) => setTimeout(() => r("parked"), 250)),
  ]);
  check("…and then parks for follow-ups rather than returning early", settled === "parked");
  runner.endTurn();
  check("…and still closes cleanly once asked", (await parked).done === true);
}

wss.close();
runner.conn?.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
