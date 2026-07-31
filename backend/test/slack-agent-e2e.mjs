// Slack AGENT app (@jungle's DM) end-to-end against a running test backend + fake Slack
// (slack-stub.mjs) + isolated test DB. Seeds a workspace with BOTH installs — the channel-mirror
// app and the agent app — because the interesting failures only appear when both exist:
// posting a DM reply with the mirror's token, or an event routing to the wrong install.
//
// Usage: node test/slack-agent-e2e.mjs <backendPort> <dbUrl> <agentSigningSecret> <stubPort>
import { createHmac } from "node:crypto";
import pg from "pg";

const PORT = process.argv[2] ?? "3055";
const DBURL = process.argv[3];
const SECRET = process.argv[4] ?? "test_agent_signing_secret";
const STUB = process.argv[5] ?? "3056";
const BASE = `http://localhost:${PORT}`;
if (!DBURL) throw new Error("usage: node slack-agent-e2e.mjs <port> <dbUrl> <agentSigningSecret> <stubPort>");

const db = new pg.Pool({ connectionString: DBURL });
const WS = "00000000-0000-0000-0000-0000000000a1";
const HUMAN = "11111111-1111-1111-1111-1111111111a1";
const JUNGLE = "22222222-2222-2222-2222-2222222222a1";
const MIRROR_CHAN = "33333333-3333-3333-3333-3333333333a1";
const WS2 = "00000000-0000-0000-0000-0000000000a2"; // a workspace with no @jungle
const WS3 = "00000000-0000-0000-0000-0000000000a3"; // connected only AFTER an event arrives
const JUNGLE3 = "22222222-2222-2222-2222-2222222222a3";
const TEAM = "TAGENT";
const TEAM2 = "TAGENT2";
const IM = "D1"; // the Slack IM between the user and the agent app's bot
const MIRROR_TOKEN = "xoxb-mirror";
const AGENT_TOKEN = "xoxb-agent";

let pass = 0;
const ok = (name) => (pass++, console.log(`  ✓ ${name}`));
const fail = (name, detail) => {
  console.error(`  ✗ ${name}\n    ${detail}`);
  process.exitCode = 1;
};
const assert = (cond, name, detail = "") => (cond ? ok(name) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recorded = async () => (await fetch(`http://localhost:${STUB}/__recorded`)).json();

async function seed() {
  await db.query(`insert into workspaces (id, name) values ($1,'Agent WS') on conflict (id) do nothing`, [WS]);
  await db.query(
    `insert into participants (id, kind, workspace_id, handle, display_name, role)
     values ($1,'human',$2,'agent-tester','Agent Tester','admin') on conflict (id) do nothing`, [HUMAN, WS]);
  // @jungle, pre-seeded so ensureJungleAgent finds it instead of provisioning a real runner.
  await db.query(
    `insert into participants (id, kind, workspace_id, handle, display_name, runner_token, jungle_default)
     values ($1,'agent',$2,'jungle','Jungle','rt-jungle',true) on conflict (id) do nothing`, [JUNGLE, WS]);
  // A channel + mirror link, so the mirror app is genuinely installed alongside the agent app.
  await db.query(
    `insert into channels (id, name, kind, workspace_id) values ($1,'general','channel',$2)
     on conflict (id) do nothing`, [MIRROR_CHAN, WS]);
  await db.query(
    `insert into slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id, kind)
     values ($1,$2,'Agent Team',$3,'UMIRROR','BMIRROR','mirror')
     on conflict (workspace_id, kind) do update set bot_token=excluded.bot_token`, [WS, TEAM, MIRROR_TOKEN]);
  await db.query(
    `insert into slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id, kind)
     values ($1,$2,'Agent Team',$3,'UAGENT','BAGENT','agent')
     on conflict (workspace_id, kind) do update set bot_token=excluded.bot_token`, [WS, TEAM, AGENT_TOKEN]);
  await db.query(
    `insert into slack_channel_links (workspace_id, jungle_channel_id, slack_team_id, slack_channel_id, slack_channel_name, install_kind)
     values ($1,$2,$3,'CMIRROR','general','mirror')
     on conflict (jungle_channel_id) do nothing`, [WS, MIRROR_CHAN, TEAM]);
}

function signedFetch(payload, { badSig = false } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = badSig ? "v0=deadbeef" : "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return fetch(`${BASE}/api/slack/agent-events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body: raw,
  });
}

function imEvent({ user = "U9", text = "hi", ts, thread_ts, event_id, bot_id, channel_type = "im", channel = IM }) {
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: event_id ?? `EvA${Math.random().toString(36).slice(2)}`,
    event: { type: "message", channel_type, user, bot_id, channel, text, ts: ts ?? `${Date.now()}.000100`, thread_ts },
  };
}

async function dmChannelId() {
  const { rows } = await db.query(
    `select jungle_channel_id from slack_channel_links where dm_agent_id=$1 and dm_slack_user_id='U9'`, [JUNGLE]);
  return rows[0]?.jungle_channel_id ?? null;
}

async function run() {
  await seed();

  // A) handshake on the agent app's own webhook.
  {
    const r = await signedFetch({ type: "url_verification", challenge: "agent-chal" });
    const j = await r.json().catch(() => ({}));
    assert(r.status === 200 && j.challenge === "agent-chal", "url_verification echoes challenge", `got ${r.status}`);
  }

  // B) the agent app verifies against its OWN signing secret.
  {
    const r = await signedFetch(imEvent({ text: "nope" }), { badSig: true });
    assert(r.status === 401, "bad signature rejected (401)", `got ${r.status}`);
  }

  // C) a DM binds the Slack IM to the person's Jungle DM with @jungle, and persists there.
  const tsC = `${Date.now()}.000200`;
  {
    const r = await signedFetch(imEvent({ user: "U9", text: "build me a thing", ts: tsC }));
    assert(r.status === 200, "message.im acked (200)", `got ${r.status}`);
    await sleep(1200);
    const { rows: link } = await db.query(
      `select * from slack_channel_links where dm_agent_id=$1 and dm_slack_user_id='U9'`, [JUNGLE]);
    assert(link.length === 1 && link[0].install_kind === "agent" && link[0].slack_channel_id === IM,
      "DM binding created against the agent install", JSON.stringify(link[0] ?? null));
    const chan = link[0]?.jungle_channel_id;
    if (chan) {
      const { rows: ch } = await db.query(`select kind from channels where id=$1`, [chan]);
      assert(ch[0]?.kind === "dm", "bound to a real Jungle DM channel", `kind=${ch[0]?.kind}`);
      const { rows: mem } = await db.query(`select participant_id from channel_members where channel_id=$1`, [chan]);
      assert(mem.some((m) => m.participant_id === JUNGLE), "@jungle is a member of that DM", JSON.stringify(mem));
      const { rows: msgs } = await db.query(`select * from messages where channel_id=$1 and body='build me a thing'`, [chan]);
      assert(msgs.length === 1, "DM message persisted", `count=${msgs.length}`);
      if (msgs[0]) {
        const { rows: out } = await db.query(`select * from slack_outbox where jungle_message_id=$1`, [msgs[0].id]);
        assert(out.length === 0, "inbound DM NOT echoed back to Slack", `outbox rows=${out.length}`);
      }
    }
  }

  // D) dedupe on event_id.
  {
    const ev = imEvent({ user: "U9", text: "dupe-dm", event_id: "EvA-dupe", ts: `${Date.now()}.000300` });
    await signedFetch(ev);
    await signedFetch(ev);
    await sleep(900);
    const chan = await dmChannelId();
    const { rows } = await db.query(`select count(*)::int n from messages where channel_id=$1 and body='dupe-dm'`, [chan]);
    assert(rows[0].n === 1, "duplicate event_id deduped", `count=${rows[0].n}`);
  }

  // E) a bot's own message is dropped (echo suppression). With N agent apps in one workspace this
  // is what stops one agent's post being re-ingested as another's input.
  {
    await signedFetch(imEvent({ user: "UAGENT", bot_id: "BAGENT", text: "i am the bot", ts: `${Date.now()}.000400` }));
    await sleep(800);
    const chan = await dmChannelId();
    const { rows } = await db.query(`select count(*)::int n from messages where channel_id=$1 and body='i am the bot'`, [chan]);
    assert(rows[0].n === 0, "bot_id message dropped (no echo loop)", `count=${rows[0].n}`);
  }

  // F) a CHANNEL message on the agent app's webhook is ignored — channels belong to the mirror app.
  //    This is the rule that stops a message being delivered twice by two apps.
  {
    await signedFetch(imEvent({ user: "U9", text: "channel msg", channel_type: "channel", channel: "CMIRROR", ts: `${Date.now()}.000500` }));
    await sleep(800);
    const { rows } = await db.query(`select count(*)::int n from messages where channel_id=$1 and body='channel msg'`, [MIRROR_CHAN]);
    assert(rows[0].n === 0, "agent app ignores channel messages (no double delivery)", `count=${rows[0].n}`);
  }

  // G) egress: @jungle's reply in the DM is delivered with the AGENT app's token, not the mirror's.
  {
    const chan = await dmChannelId();
    const { rows: ins } = await db.query(
      `insert into messages (channel_id, sender_id, body, cascade_budget) values ($1,$2,'here you go',0) returning id`,
      [chan, JUNGLE]);
    const mid = ins[0].id;
    const { rows: link } = await db.query(`select id from slack_channel_links where jungle_channel_id=$1`, [chan]);
    await db.query(`insert into slack_outbox (link_id, jungle_message_id) values ($1,$2)`, [link[0].id, mid]);
    let delivered = false;
    for (let i = 0; i < 12; i++) {
      await sleep(600);
      const { rows } = await db.query(`select status from slack_outbox where jungle_message_id=$1`, [mid]);
      if (rows[0]?.status === "delivered") { delivered = true; break; }
    }
    assert(delivered, "DM reply delivered by the existing outbox ticker", "still pending after ~7s");
    const { posted } = await recorded();
    const dm = posted.find((p) => p.text === "here you go");
    assert(!!dm && dm.channel === IM, "reply posted to the Slack IM", JSON.stringify(dm ?? null));
    assert(!!dm && dm.token === AGENT_TOKEN, "posted with the AGENT app's token, not the mirror's", `token=${dm?.token}`);
  }

  // H) App Home publishes a roster.
  {
    await signedFetch({ type: "event_callback", team_id: TEAM, event_id: `EvA-home-${Date.now()}`,
      event: { type: "app_home_opened", user: "U9" } });
    await sleep(900);
    const { published } = await recorded();
    const home = published.find((p) => p.user === "U9");
    assert(!!home && home.blocks.length > 0, "app_home_opened published a view", JSON.stringify(home ?? null));
    assert(!!home && home.token === AGENT_TOKEN, "App Home published with the agent app's token", `token=${home?.token}`);
  }

  // I) a workspace with no @jungle at all (nobody on a Claude subscription) gets an explanation in
  //    the DM, not silence. ensureJungleAgent returns null there.
  {
    await db.query(`insert into workspaces (id, name) values ($1,'No Jungle WS') on conflict (id) do nothing`, [WS2]);
    await db.query(
      `insert into slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id, kind)
       values ($1,$2,'No Jungle Team','xoxb-agent2','UAGENT2','BAGENT2','agent')
       on conflict (workspace_id, kind) do update set bot_token=excluded.bot_token`, [WS2, TEAM2]);
    const ev = imEvent({ user: "U8", text: "anyone home?", channel: "D2", ts: `${Date.now()}.000600` });
    ev.team_id = TEAM2;
    await signedFetch(ev);
    await sleep(1200);
    const { posted } = await recorded();
    const reply = posted.find((p) => p.channel === "D2");
    assert(!!reply && /subscription/i.test(reply.text), "no-@jungle workspace gets an explanation, not silence",
      JSON.stringify(reply ?? null));
    const { rows } = await db.query(
      `select count(*)::int n from slack_channel_links where slack_team_id=$1`, [TEAM2]);
    assert(rows[0].n === 0, "no DM binding created when there is no agent", `links=${rows[0].n}`);
  }

  // J) an event that arrives BEFORE the workspace is connected must not burn its event id —
  //    otherwise connecting later can't help, because Slack's retry is deduped away. This is the
  //    exact shape of the first real-world failure: app installed in Slack, never connected in
  //    Jungle, DMs silently swallowed.
  {
    const evId = "EvA-unconnected-1";
    const ev = imEvent({ user: "U7", text: "before connect", channel: "D3", ts: `${Date.now()}.000700`, event_id: evId });
    ev.team_id = "TNOTCONNECTED";
    await signedFetch(ev);
    await sleep(800);
    const { rows: burned } = await db.query(`select count(*)::int n from slack_events where event_id=$1`, [evId]);
    assert(burned[0].n === 0, "event id NOT consumed when the workspace isn't connected", `rows=${burned[0].n}`);

    // Now connect that workspace and replay the same event id: it must be processed, not deduped.
    await db.query(`insert into workspaces (id, name) values ($1,'Late Connect WS') on conflict (id) do nothing`, [WS3]);
    await db.query(
      `insert into participants (id, kind, workspace_id, handle, display_name, runner_token, jungle_default)
       values ($1,'agent',$2,'jungle','Jungle','rt-jungle3',true) on conflict (id) do nothing`, [JUNGLE3, WS3]);
    await db.query(
      `insert into slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id, kind)
       values ($1,'TNOTCONNECTED','Late Team','xoxb-agent3','UAGENT3','BAGENT3','agent')
       on conflict (workspace_id, kind) do update set bot_token=excluded.bot_token`, [WS3]);
    await signedFetch(ev);
    await sleep(1200);
    const { rows: link } = await db.query(
      `select jungle_channel_id from slack_channel_links where dm_agent_id=$1 and dm_slack_user_id='U7'`, [JUNGLE3]);
    assert(link.length === 1, "the same event succeeds once the workspace is connected", `links=${link.length}`);
    if (link[0]) {
      const { rows: m } = await db.query(
        `select count(*)::int n from messages where channel_id=$1 and body='before connect'`, [link[0].jungle_channel_id]);
      assert(m[0].n === 1, "the replayed message was persisted", `count=${m[0].n}`);
    }
  }

  console.log(`\n${pass} assertions passed`);
  await db.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
