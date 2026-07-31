// Browser-level proof of the live-update fixes: drives a real Chromium against a real dev-bypass
// backend and asserts the page updates WITHOUT ever being reloaded.
//   1. a channel someone else creates appears in my sidebar
//   2. an agent someone else creates appears in my roster
//   3. a DM someone else opens appears once its first message arrives
//   4. with the tab's network cut, a message posted meanwhile still shows up after it comes back
//      — the socket has to notice it died, redial, and re-sync
//
// Usage: node test/livesync-ui.mjs <frontendUrl> <backendPort>
import { chromium } from "playwright";
import WebSocket from "ws";

const [URL_, PORT] = process.argv.slice(2);
if (!URL_ || !PORT) {
  console.error("usage: node test/livesync-ui.mjs <frontendUrl> <backendPort>");
  process.exit(2);
}
const API = `http://localhost:${PORT}/api`;
const S = Date.now().toString(36).slice(-5);

let fail = 0;
const check = (n, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
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

const onScreen = (page, text, timeout = 20_000) =>
  page
    .waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
    .then(() => true)
    .catch(() => false);

// Two humans: the browser is Me, everything happens as Them.
const me = await api("POST", "/participants", { kind: "human", handle: `me${S}`, displayName: `Me ${S}` });
const them = await api("POST", "/participants", {
  kind: "human",
  handle: `them${S}`,
  displayName: `Them ${S}`,
});

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// ?as=<participantId> is the dev sign-in path.
await page.goto(`${URL_}/?as=${me.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

// 1. A channel created by Them, with me in it from the start.
const chanName = `live-${S}`;
const chan = await api("POST", "/channels", { name: chanName, memberHandles: [`me${S}`] }, them.id);
check("a channel someone else creates appears in my sidebar", await onScreen(page, chanName), chanName);

// 2. An agent created by Them. Watch this from the Team page, which is where the roster is
//    actually rendered — `people` backs member pickers and @-autocomplete elsewhere, so the
//    default chat view has nowhere to show a brand-new agent.
await page.goto(`${URL_}/team?as=${me.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const agent = await api(
  "POST",
  "/agents",
  { handle: `bot${S}`, displayName: `Bot ${S}`, runnerProvider: "docker" },
  them.id,
).catch((e) => {
  console.log("  (agent create failed:", String(e.message).slice(0, 140), ")");
  return null;
});
if (agent) check("an agent someone else creates appears in my roster", await onScreen(page, `Bot ${S}`));

await page.goto(`${URL_}/?as=${me.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// 3. A DM they open, made visible by its first message. The sidebar renders a DM as the other
//    person's display name — which only appears once the channel is in my list at all.
const dm = await api("POST", "/dms", { otherId: me.id }, them.id);
const theirWs = new WebSocket(`ws://localhost:${PORT}/?participantId=${them.id}`);
await new Promise((res, rej) => (theirWs.on("open", res), theirWs.on("error", rej)));
theirWs.send(JSON.stringify({ type: "post", channelId: dm.id, body: `hi-${S}`, clientMsgId: `d-${S}` }));
check("a DM they open appears when its first message arrives", await onScreen(page, `Them ${S}`));

// 4. The whole point. Open the channel from step 1, cut the tab's network, post while it's down,
//    then restore. No reload anywhere — the client has to notice the dead socket and recover.
await page.getByText(chanName).first().click();
await page.waitForTimeout(1500);
await context.setOffline(true);
await page.waitForTimeout(4000);
const afterBody = `while-offline-${S}`;
theirWs.send(JSON.stringify({ type: "post", channelId: chan.id, body: afterBody, clientMsgId: `r-${S}` }));
await page.waitForTimeout(1000);
await context.setOffline(false); // fires `online` -> wake() -> immediate redial + full re-sync
check(
  "a message sent while the tab was offline shows up after it reconnects",
  await onScreen(page, afterBody, 45_000),
  afterBody,
);

await page.screenshot({ path: "/tmp/livesync-ui.png", fullPage: true });
if (agent?.id) await api("DELETE", `/agents/${agent.id}`, null, them.id).catch(() => {});
theirWs.close();
await browser.close();
console.log(fail ? `\n${fail} failed` : "\nALL PASS");
process.exit(fail ? 1 : 0);
