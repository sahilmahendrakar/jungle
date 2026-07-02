// Validates attachments end to end against a real runner container:
//   human upload -> signed URL serving (+ tamper rejection) -> message with attachment ->
//   agent downloads the file AND sees it as an image block (names its color) ->
//   agent creates + sends a file back via send_message files -> humans get a signed URL.
// Run:  node test/attachments-test.mjs <port> <humanParticipantId>
// Needs the AUTH_DEV_BYPASS=1 test backend on <port> (same setup as delete-agent-test).
import WebSocket from "ws";
import { deflateSync } from "node:zlib";

const PORT = process.argv[2] ?? "3011";
const HUMAN = process.argv[3];
if (!HUMAN) throw new Error("usage: node attachments-test.mjs <port> <humanParticipantId>");
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api`;
const HANDLE = `atttest-${Date.now().toString(36).slice(-4)}`;

const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

// Minimal solid-color PNG (truecolor 8-bit), pure Node — no image deps in the backend tests.
function solidPng(width, height, [r, g, b]) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const seen = [];
const waiters = [];
function waitFor(name, match, timeoutMs = 180_000) {
  const hit = seen.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}

async function main() {
  // 1. Upload a solid red PNG as the human (dev-bypass auth via ?participantId=).
  const png = solidPng(32, 32, [220, 20, 20]);
  const upRes = await fetch(
    `${API}/attachments?filename=red.png&mime=image/png&participantId=${HUMAN}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: png },
  );
  const up = await upRes.json();
  check("upload returns 201 + id + url", upRes.status === 201 && !!up.id && !!up.url, JSON.stringify({ id: up.id, size: up.size_bytes }));
  check("upload extracted image dimensions", up.width === 32 && up.height === 32, `${up.width}x${up.height}`);

  // 2. Signed URL serves the exact bytes inline; a tampered signature is rejected.
  const dl = await fetch(`${BASE}${up.url}`);
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  check("signed URL serves bytes inline", dl.status === 200 && dl.headers.get("content-type") === "image/png" && dlBytes.equals(png), `status=${dl.status} len=${dlBytes.length}`);
  const bad = await fetch(`${BASE}${up.url.replace(/sig=....../, "sig=000000")}`);
  check("tampered signature rejected", bad.status === 403, `status=${bad.status}`);
  const unauth = await fetch(`${API}/attachments?filename=x.png&mime=image/png`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: png,
  });
  check("unauthenticated upload rejected", unauth.status === 401, `status=${unauth.status}`);

  // 3. Throwaway agent (bypassPermissions so it can Write files without a confirm card).
  const agent = await api("POST", "/agents", {
    handle: HANDLE, displayName: "Attachment Test", mode: "bypassPermissions",
    model: "claude-haiku-4-5-20251001",
  });
  check("agent created", !!agent.id, `id=${agent.id}`);
  const dm = await api("POST", "/dms", { participantId: HUMAN, otherId: agent.id });

  const ws = new WebSocket(`ws://localhost:${PORT}?participantId=${HUMAN}`);
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
  });
  await new Promise((r) => ws.on("open", r));

  log("waiting 20s for container boot…");
  await new Promise((r) => setTimeout(r, 20_000));

  // 4. Post a message carrying the attachment. The agent must SEE the image (color) and
  //    send a file back (files param round-trip).
  ws.send(JSON.stringify({
    type: "post",
    channelId: dm.id,
    clientMsgId: `att-${Date.now()}`,
    body:
      `@${HANDLE} Two tasks, one reply: ` +
      `(1) state the dominant color of the attached image as a single lowercase word; ` +
      `(2) create a file /workspace/reply.txt containing exactly the word banana, and attach ` +
      `it to your reply using send_message's files parameter.`,
    attachmentIds: [up.id],
  }));

  const mine = await waitFor(
    "my message echoed with attachment",
    (f) => f.type === "message" && f.message?.sender_id === HUMAN && f.message.channel_id === dm.id,
    15_000,
  );
  const echoAtt = mine.message.attachments ?? [];
  check("posted message carries attachment + url", echoAtt.length === 1 && echoAtt[0].id === up.id && !!echoAtt[0].url, JSON.stringify(echoAtt.map((a) => a.filename)));

  // 5. Agent's reply: names the color (vision path) and carries a file (upload path).
  const reply = await waitFor(
    "agent reply",
    (f) => f.type === "message" && f.message?.sender_id === agent.id,
  );
  const body = reply.message.body.toLowerCase();
  check("agent saw the image (named red)", body.includes("red"), JSON.stringify(reply.message.body.slice(0, 120)));
  const replyAtt = reply.message.attachments ?? [];
  check("agent reply carries an attachment", replyAtt.length >= 1, JSON.stringify(replyAtt.map((a) => a.filename)));
  if (replyAtt.length) {
    const back = await fetch(`${BASE}${replyAtt[0].url}`);
    const text = Buffer.from(await back.arrayBuffer()).toString("utf8");
    check("agent's file downloads with expected content", back.status === 200 && text.trim() === "banana", JSON.stringify(text.slice(0, 40)));
    check("non-image served as forced download", back.headers.get("content-disposition")?.startsWith("attachment"), back.headers.get("content-disposition") ?? "");
  } else {
    fail += 2;
    log("FAIL agent's file downloads (no attachment)"); log("FAIL non-image forced download (no attachment)");
  }

  // 6. History endpoint carries attachments too.
  const hist = await api("GET", `/channels/${dm.id}/messages`);
  const histMine = hist.find((m) => m.id === mine.message.id);
  check("history carries attachments", (histMine?.attachments ?? []).length === 1 && !!histMine.attachments[0].url);

  // Cleanup: delete the throwaway agent (tears down container + volume + DM + messages).
  await api("DELETE", `/agents/${agent.id}?participantId=${HUMAN}`);
  log("cleanup: agent deleted");

  ws.close();
  log(`DONE: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
