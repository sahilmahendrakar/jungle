// Unit tests for the Slack pure helpers (signature verification + mrkdwn conversion). No backend
// or Slack needed. Run with tsx so the .ts modules import directly:
//   npx tsx backend/test/slack-unit.mjs
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { verifySlackSignature } from "../src/slack/verify.ts";
import { slackToJungleText, jungleToSlackText, mentionedSlackUserIds } from "../src/slack/format.ts";

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// --- signature ---
const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const ts = Math.floor(Date.now() / 1000).toString();
const raw = Buffer.from(JSON.stringify({ type: "url_verification", challenge: "abc" }));
const good = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw.toString("utf8")}`).digest("hex");

assert.equal(verifySlackSignature(secret, raw, ts, good), true);
ok("valid signature accepted");
assert.equal(verifySlackSignature(secret, raw, ts, "v0=deadbeef"), false);
ok("bad signature rejected");
assert.equal(verifySlackSignature(secret, raw, "1", good), false);
ok("stale timestamp rejected");
assert.equal(verifySlackSignature("", raw, ts, good), false);
ok("empty secret rejected");
assert.equal(verifySlackSignature(secret, raw, undefined, good), false);
ok("missing timestamp rejected");

// --- slack -> jungle ---
const resolver = (id) => (id === "U123" ? "scout" : null);
assert.equal(slackToJungleText("hey <@U123> do it", resolver), "hey @scout do it");
ok("resolved user mention -> @handle");
assert.equal(slackToJungleText("hi <@U999|Jane Doe>", resolver), "hi Jane Doe");
ok("unresolved mention -> plain inline name (no @)");
assert.equal(slackToJungleText("see <#C1|general>"), "see #general");
ok("channel mention -> #name");
assert.equal(slackToJungleText("look <https://x.com|here>"), "look here (https://x.com)");
ok("labeled link -> label (url)");
assert.equal(slackToJungleText("<https://x.com>"), "https://x.com");
ok("bare link preserved");
assert.equal(slackToJungleText("a &amp; b &lt;tag&gt;"), "a & b <tag>");
ok("html entities unescaped");
assert.equal(slackToJungleText("cc <!here> please"), "cc @here please");
ok("!here special");

// mentionedSlackUserIds
assert.deepEqual(mentionedSlackUserIds("<@U1> and <@U2|x> and <@U1>"), ["U1", "U2"]);
ok("mentionedSlackUserIds dedupes");

// --- jungle -> slack ---
assert.equal(jungleToSlackText("a & b <c> >d"), "a &amp; b &lt;c&gt; &gt;d");
ok("egress escapes entities");
// round-trip safety on the three entities
assert.equal(slackToJungleText(jungleToSlackText("if a < b && c > d")), "if a < b && c > d");
ok("entity round-trip is stable");

console.log(`\n${passed} assertions passed`);
