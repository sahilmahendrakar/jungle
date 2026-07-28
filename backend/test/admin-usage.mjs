// Admin (operator) API check: the allowlist gate, the four /api/admin/* endpoints, and that the
// numbers they report agree with each other.
//   Run:  node test/admin-usage.mjs <backendPort> <adminParticipantId> [nonAdminParticipantId]
// Assumes a backend on that port with AUTH_DEV_BYPASS=1, pointed at a TEST database (it reads
// only, but the participant ids are database-specific). The admin participant's email must be on
// the backend's ADMIN_EMAILS list; the optional second id must not be.
const PORT = process.argv[2] ?? "3002";
const ADMIN = process.argv[3];
const OUTSIDER = process.argv[4];
if (!ADMIN) throw new Error("usage: node admin-usage.mjs <port> <adminParticipantId> [nonAdminId]");
const API = `http://localhost:${PORT}/api`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const get = async (path, participantId) => {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${API}${path}${participantId ? `${sep}participantId=${participantId}` : ""}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// --- the gate ---
check("anonymous is refused", (await get("/admin/overview")).status === 403);
if (OUTSIDER) {
  check("non-allowlisted account is refused", (await get("/admin/overview", OUTSIDER)).status === 403);
}

// --- overview ---
const { status, body: overview } = await get("/admin/overview?window=30d", ADMIN);
check("operator gets the overview", status === 200, `status ${status}`);
const t = overview.totals ?? {};
check("totals are populated", typeof t.users === "number" && typeof t.agents === "number");
check("tokens.total is the sum of its parts",
  t.tokens && t.tokens.total === t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite);
check("active agents never exceed total agents", t.activeAgents <= t.agents, `${t.activeAgents}/${t.agents}`);
check("the daily series is dense (one point per day, oldest first)",
  overview.daily.length >= 2 &&
    overview.daily.every((p, i, a) => i === 0 || p.date > a[i - 1].date) &&
    overview.granularity === "day");
const seriesCost = overview.daily.reduce((s, p) => s + p.costUsd, 0);
check("the series sums to the window's spend", Math.abs(seriesCost - t.costUsd) < 0.01,
  `series ${seriesCost.toFixed(2)} vs total ${Number(t.costUsd).toFixed(2)}`);
check("24h window switches to hourly buckets",
  (await get("/admin/overview?window=24h", ADMIN)).body.granularity === "hour");

// --- accounts + per-agent drill-in ---
const { body: acctBody } = await get("/admin/accounts?window=30d", ADMIN);
const accounts = acctBody.accounts ?? [];
check("accounts are returned, most expensive first", accounts.length > 0 &&
  accounts.every((a, i) => i === 0 || a.costUsd <= accounts[i - 1].costUsd));
const acctCost = accounts.reduce((s, a) => s + a.costUsd, 0);
check("account spend sums to the platform total", Math.abs(acctCost - t.costUsd) < 0.01,
  `accounts ${acctCost.toFixed(2)} vs total ${Number(t.costUsd).toFixed(2)}`);

const spender = accounts.find((a) => a.costUsd > 0) ?? accounts[0];
const { body: agentBody } = await get(
  `/admin/agents?window=30d&account=${encodeURIComponent(spender.key)}`, ADMIN);
const agents = agentBody.agents ?? [];
const agentCost = agents.reduce((s, a) => s + a.costUsd, 0);
check("an account's agents sum to that account's spend", Math.abs(agentCost - spender.costUsd) < 0.01,
  `${spender.key}: agents ${agentCost.toFixed(2)} vs account ${spender.costUsd.toFixed(2)}`);
check("agent rows carry their own labels", agents.every((a) => typeof a.handle === "string"));

// --- activity ---
const { body: actBody } = await get("/admin/activity?window=30d&limit=5", ADMIN);
const items = actBody.items ?? [];
check("activity is newest-first and bounded by the limit",
  items.length <= 5 && items.every((it, i) => i === 0 || it.at <= items[i - 1].at));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
