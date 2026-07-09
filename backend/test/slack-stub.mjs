// A tiny fake Slack Web API for local bridge testing (set SLACK_API_BASE to this server's origin).
// Records chat.postMessage calls so the egress path can be asserted. Run: node test/slack-stub.mjs <port>
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 3056);
export const posted = [];
let tsCounter = 1000;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const method = req.url.replace(/^\/+/, "");
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = req.headers["content-type"]?.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
    } catch {
      /* ignore */
    }
    const json = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (method === "users.info") {
      // Deterministic fake profile keyed by the user id.
      const u = body.user || "U0";
      return json({
        ok: true,
        user: {
          id: u,
          name: u.toLowerCase(),
          real_name: `Real ${u}`,
          is_bot: false,
          profile: { display_name: `Slack ${u}`, email: `${u.toLowerCase()}@example.com`, image_512: `https://img/${u}.png` },
        },
      });
    }
    if (method === "chat.postMessage") {
      const ts = `${tsCounter++}.000100`;
      posted.push({ channel: body.channel, text: body.text, username: body.username, thread_ts: body.thread_ts, ts });
      console.log(`STUB chat.postMessage -> #${body.channel} as "${body.username}": ${JSON.stringify(body.text)}${body.thread_ts ? ` (thread ${body.thread_ts})` : ""}`);
      return json({ ok: true, ts });
    }
    if (method === "conversations.join") return json({ ok: true });
    if (method === "conversations.info") return json({ ok: true, channel: { id: body.channel, name: "stub-channel" } });
    if (method === "auth.test") return json({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: "T1" });
    return json({ ok: false, error: "unknown_method" });
  });
});
server.listen(PORT, () => console.log(`slack stub on http://localhost:${PORT}`));
