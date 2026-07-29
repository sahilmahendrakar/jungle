import type {
  AdminAccount,
  AdminActivityItem,
  AdminAgentUsage,
  AdminDailyPoint,
  AdminModelUsage,
  AdminOverview,
  AdminTokens,
  AdminTotals,
  AdminWindow,
} from "@jungle/shared";
import { providerForModelId } from "@jungle/shared";
import { pool } from "./pool";

// Usage + spend: writing one agent_usage row per (SDK result event, model), and the aggregate
// queries behind the admin view. See migrations/040_usage_admin.sql for the table's shape and why
// it denormalizes the agent + owner labels.

// The SDK's per-model usage block inside a `result` stream message.
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

// Group agent_usage rows into accounts the same way the migration's backfill does: by email when
// there is one, else by the owning participant, else "unattributed" (an agent created before
// migrations/040 in a workspace that had no human).
const ACCOUNT_KEY = `coalesce(lower(u.owner_email), 'participant:' || u.owner_id::text, 'unattributed')`;
// Turns, not result events: one turn can emit several results (a spliced follow-up, a reconnect),
// and each result can report several models.
const TURNS = `count(distinct coalesce(u.turn_id, 'evt:' || u.id::text))`;
const ACTIVE_AGENTS = `count(distinct coalesce(u.agent_id::text, 'h:' || u.agent_handle))`;
// Resolve a LIVE agent row (aliased `a`) to its owning human, as `o`. Mirrors the write path in
// recordTurnUsage: the recorded creator, else the workspace's admin / earliest human — so an
// agent created by the Architect (no creator) lands on the same account its usage rows did.
const AGENT_OWNER_LATERAL = `
  left join lateral (
    select h.id, h.email, h.display_name
      from participants h
     where h.id = a.created_by
        or (a.created_by is null and h.workspace_id = a.workspace_id and h.kind = 'human')
     order by (h.id = a.created_by) desc, (h.role = 'admin') desc, h.created_at asc
     limit 1
  ) o on true`;
// The account key for that resolved owner. Must agree with ACCOUNT_KEY above.
const OWNER_KEY = `coalesce(lower(o.email), 'participant:' || o.id::text, 'unattributed')`;
const TOKEN_SUMS = `
  coalesce(sum(u.input_tokens), 0)       as input_tokens,
  coalesce(sum(u.output_tokens), 0)      as output_tokens,
  coalesce(sum(u.cache_read_tokens), 0)  as cache_read_tokens,
  coalesce(sum(u.cache_write_tokens), 0) as cache_write_tokens,
  coalesce(sum(u.cost_usd), 0)           as cost_usd`;

interface TokenRow {
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
}

function tokens(r: TokenRow): AdminTokens {
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const cacheRead = num(r.cache_read_tokens);
  const cacheWrite = num(r.cache_write_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// The cutoff a window maps to (null = all time). Exported so routes can echo it back.
export function windowSince(w: AdminWindow): Date | null {
  const hours = w === "24h" ? 24 : w === "7d" ? 24 * 7 : w === "30d" ? 24 * 30 : 0;
  return hours ? new Date(Date.now() - hours * 3600_000) : null;
}

// When usage was first recorded, never earlier than `maxDays` ago (the "all time" chart's left
// edge). Falls back to `maxDays` ago on an empty table.
async function firstUsageAt(maxDays: number): Promise<Date> {
  const floor = new Date(Date.now() - maxDays * 24 * 3600_000);
  const { rows } = await pool.query<{ first: string | null }>(
    `select min(created_at) as first from agent_usage`,
  );
  const first = rows[0]?.first ? new Date(rows[0].first) : null;
  return first && first > floor ? first : floor;
}

// --- write path ---------------------------------------------------------------------------

// Record a runner's `result` event. Called for every result the orchestrator sees; a result with
// no modelUsage (older CLI, or an error before any model call) records nothing. Idempotent on the
// event's uuid, so a replayed frame — or the migration's backfill running over the same event —
// can't double-count. Returns the number of model rows written.
export async function recordTurnUsage(
  agentId: string,
  turnId: string | null,
  event: unknown,
): Promise<number> {
  const e = event as {
    type?: string;
    uuid?: string;
    modelUsage?: Record<string, ModelUsage>;
    duration_ms?: number;
    is_error?: boolean;
  };
  if (e?.type !== "result" || !e.modelUsage || typeof e.modelUsage !== "object") return 0;
  const models = Object.entries(e.modelUsage).filter(([m]) => !!m);
  if (!models.length) return 0;

  // The labels we freeze onto each row (the agent and its creator can both be deleted later).
  // `subscription` rides along: whether this turn was billed to the creator's own Claude
  // subscription rather than the org API key, which is what makes the spend cap able to exclude it
  // (see migrations/043_spend_limits.sql). Read as "does the owner have a token now" — the runner
  // resolves it the same way at configure time, so the two agree except across a token change
  // mid-session, which is not worth a second source of truth.
  const { rows: ctx } = await pool.query<{
    handle: string;
    workspace_id: string;
    owner_id: string | null;
    owner_email: string | null;
    owner_name: string | null;
    subscription: boolean;
  }>(
    // Owner = the recorded creator, else the workspace's admin (earliest human): agents created
    // by a workflow's Architect or by an internal path have no creator, and their spend still has
    // to land on somebody. Same rule the 040 backfill used.
    `select a.handle, a.workspace_id, o.id as owner_id, o.email as owner_email,
            o.display_name as owner_name,
            o.claude_oauth_token is not null as subscription
       from participants a
       left join lateral (
         select h.id, h.email, h.display_name, h.claude_oauth_token
           from participants h
          where h.id = a.created_by
             or (a.created_by is null and h.workspace_id = a.workspace_id and h.kind = 'human')
          order by (h.id = a.created_by) desc, (h.role = 'admin') desc, h.created_at asc
          limit 1
       ) o on true
      where a.id = $1`,
    [agentId],
  );
  if (!ctx.length) return 0; // agent deleted mid-turn
  const c = ctx[0];

  const cols = 19;
  const values: unknown[] = [];
  const tuples = models.map(([model, mu], i) => {
    // Which provider's key this model's share of the turn was billed to, and whether it went to
    // the creator's personal subscription instead. Both are what the daily spend cap reads; a
    // model we can't classify records a null provider and counts against no cap.
    const provider = providerForModelId(model);
    values.push(
      e.uuid ?? null,
      agentId,
      c.handle,
      c.workspace_id,
      c.owner_id,
      c.owner_email,
      c.owner_name,
      turnId,
      model,
      provider,
      // Routed providers bring their own endpoint + key, so a subscription token never applies to
      // them — the runner enforces the same precedence when it builds the CLI child env.
      provider === "anthropic" && c.subscription,
      Math.round(num(mu?.inputTokens)),
      Math.round(num(mu?.outputTokens)),
      Math.round(num(mu?.cacheReadInputTokens)),
      Math.round(num(mu?.cacheCreationInputTokens)),
      Math.round(num(mu?.webSearchRequests)),
      num(mu?.costUSD),
      Number.isFinite(e.duration_ms) ? Math.round(num(e.duration_ms)) : null,
      e.is_error !== true,
    );
    const base = i * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(", ")})`;
  });

  const { rowCount } = await pool.query(
    `insert into agent_usage
       (event_uuid, agent_id, agent_handle, workspace_id, owner_id, owner_email, owner_name,
        turn_id, model, provider, subscription, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, web_search_requests, cost_usd, duration_ms, ok)
     values ${tuples.join(", ")}
     on conflict do nothing`,
    values,
  );
  return rowCount ?? 0;
}

// --- admin read path ----------------------------------------------------------------------

// Platform totals + the daily spend series + the model split, for one window. The counters that
// describe platform SIZE (users/workspaces/agents) are all-time; the rest is window-scoped.
export async function adminOverview(window: AdminWindow): Promise<AdminOverview> {
  const since = windowSince(window);
  // An explicit window charts its whole span (quiet days included — that's information). "all"
  // has no span, so it starts at the first recorded turn, floored at 90 days back so the chart
  // can't grow unbounded and so empty pre-launch months don't squeeze the real data.
  const seriesSince = since ?? (await firstUsageAt(90));
  // A 24h window is two bars at daily granularity — bucket it hourly instead.
  const granularity: "hour" | "day" = window === "24h" ? "hour" : "day";
  const bucket = granularity === "hour" ? "hour" : "day";
  const bucketFormat = granularity === "hour" ? `'YYYY-MM-DD"T"HH24:00"Z"'` : `'YYYY-MM-DD'`;

  const [sizes, usage, msgs, daily, models] = await Promise.all([
    pool.query<{ users: string; workspaces: string; agents: string }>(
      `select (select count(distinct coalesce(lower(email), 'participant:' || id::text))
                 from participants where kind = 'human') as users,
              (select count(*) from workspaces) as workspaces,
              (select count(*) from participants where kind = 'agent') as agents`,
    ),
    pool.query<TokenRow & { turns: string; active_agents: string; cost_usd: string }>(
      `select ${TURNS} as turns, ${ACTIVE_AGENTS} as active_agents, ${TOKEN_SUMS}
         from agent_usage u
        where ($1::timestamptz is null or u.created_at >= $1)`,
      [since],
    ),
    pool.query<{ messages: string }>(
      `select count(*) as messages from messages
        where ($1::timestamptz is null or created_at >= $1)`,
      [since],
    ),
    // Dense series: every UTC day in the window gets a point, including the ones with no spend —
    // a bar chart whose x-axis silently skips quiet days misreads as continuous time.
    pool.query<{ date: string; cost_usd: string; turns: string; tokens: string }>(
      `with days as (
         select generate_series(date_trunc('${bucket}', $1::timestamptz at time zone 'UTC'),
                                date_trunc('${bucket}', now() at time zone 'UTC'),
                                interval '1 ${bucket}') as day
       ),
       per_day as (
         select date_trunc('${bucket}', u.created_at at time zone 'UTC') as day,
                coalesce(sum(u.cost_usd), 0) as cost_usd,
                ${TURNS} as turns,
                coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens
                             + u.cache_write_tokens), 0) as tokens
           from agent_usage u
          where u.created_at >= $1
          group by 1
       )
       select to_char(d.day, ${bucketFormat}) as date,
              coalesce(p.cost_usd, 0) as cost_usd,
              coalesce(p.turns, 0) as turns,
              coalesce(p.tokens, 0) as tokens
         from days d left join per_day p on p.day = d.day
        order by d.day asc`,
      [seriesSince],
    ),
    pool.query<{ model: string; turns: string; tokens: string; cost_usd: string }>(
      `select u.model,
              ${TURNS} as turns,
              coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens
                           + u.cache_write_tokens), 0) as tokens,
              coalesce(sum(u.cost_usd), 0) as cost_usd
         from agent_usage u
        where ($1::timestamptz is null or u.created_at >= $1)
        group by 1 order by cost_usd desc`,
      [since],
    ),
  ]);

  const u = usage.rows[0];
  const totals: AdminTotals = {
    users: num(sizes.rows[0].users),
    workspaces: num(sizes.rows[0].workspaces),
    agents: num(sizes.rows[0].agents),
    activeAgents: num(u.active_agents),
    turns: num(u.turns),
    messages: num(msgs.rows[0].messages),
    tokens: tokens(u),
    costUsd: num(u.cost_usd),
  };
  const points: AdminDailyPoint[] = daily.rows.map((r) => ({
    date: r.date,
    costUsd: num(r.cost_usd),
    turns: num(r.turns),
    tokens: num(r.tokens),
  }));
  const modelRows: AdminModelUsage[] = models.rows.map((r) => ({
    model: r.model,
    turns: num(r.turns),
    tokens: num(r.tokens),
    costUsd: num(r.cost_usd),
  }));
  return {
    window,
    since: since?.toISOString() ?? null,
    totals,
    granularity,
    daily: points,
    models: modelRows,
  };
}

// Every account, with its workspaces, agent count, and window usage — the admin table's rows.
// Accounts with no usage still appear (that's a signal); usage whose owning participant has since
// been deleted still appears too, labelled from the frozen email on the usage rows.
export async function adminAccounts(window: AdminWindow): Promise<AdminAccount[]> {
  const since = windowSince(window);
  const { rows } = await pool.query<
    TokenRow & {
      key: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      workspaces: { id: string; name: string; role: string }[] | null;
      agents: string;
      active_agents: string;
      turns: string;
      cost_usd: string;
      joined_at: string | null;
      last_active_at: string | null;
    }
  >(
    `with humans as (
       select p.id, p.email, p.display_name, p.avatar_url, p.created_at, p.workspace_id, p.role,
              coalesce(lower(p.email), 'participant:' || p.id::text) as key
         from participants p where p.kind = 'human'
     ),
     accounts as (
       select h.key,
              min(h.created_at) as joined_at,
              (array_agg(h.email order by h.created_at) filter (where h.email is not null))[1] as email,
              (array_agg(h.display_name order by h.created_at))[1] as name,
              (array_agg(h.avatar_url order by h.created_at) filter (where h.avatar_url is not null))[1] as avatar_url,
              jsonb_agg(distinct jsonb_build_object('id', w.id, 'name', w.name, 'role', h.role)) as workspaces
         from humans h left join workspaces w on w.id = h.workspace_id
        group by h.key
     ),
     owned as (
       select ${OWNER_KEY} as key, count(*) as agents
         from participants a ${AGENT_OWNER_LATERAL}
        where a.kind = 'agent'
        group by 1
     ),
     windowed as (
       select ${ACCOUNT_KEY} as key, ${TURNS} as turns, ${ACTIVE_AGENTS} as active_agents, ${TOKEN_SUMS}
         from agent_usage u
        where ($1::timestamptz is null or u.created_at >= $1)
        group by 1
     ),
     lifetime as (
       select ${ACCOUNT_KEY} as key, max(u.created_at) as last_active_at,
              (array_agg(u.owner_email order by u.created_at desc)
                 filter (where u.owner_email is not null))[1] as email
         from agent_usage u group by 1
     ),
     keys as (
       select key from accounts union select key from windowed union select key from lifetime
     )
     select k.key,
            coalesce(a.email, l.email) as email,
            a.name, a.avatar_url,
            coalesce(a.workspaces, '[]'::jsonb) as workspaces,
            coalesce(o.agents, 0) as agents,
            coalesce(w.turns, 0) as turns,
            coalesce(w.active_agents, 0) as active_agents,
            coalesce(w.input_tokens, 0) as input_tokens,
            coalesce(w.output_tokens, 0) as output_tokens,
            coalesce(w.cache_read_tokens, 0) as cache_read_tokens,
            coalesce(w.cache_write_tokens, 0) as cache_write_tokens,
            coalesce(w.cost_usd, 0) as cost_usd,
            a.joined_at, l.last_active_at
       from keys k
       left join accounts a on a.key = k.key
       left join owned o on o.key = k.key
       left join windowed w on w.key = k.key
       left join lifetime l on l.key = k.key
      order by cost_usd desc, a.joined_at asc nulls last`,
    [since],
  );
  return rows.map((r) => ({
    key: r.key,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatar_url,
    workspaces: (r.workspaces ?? []).filter((w) => w && w.id),
    agents: num(r.agents),
    activeAgents: num(r.active_agents),
    turns: num(r.turns),
    tokens: tokens(r),
    costUsd: num(r.cost_usd),
    joinedAt: r.joined_at ?? new Date(0).toISOString(),
    lastActiveAt: r.last_active_at,
  }));
}

// Per-agent usage in the window, optionally for one account (the expanded row's detail). Includes
// agents with no usage in the window (so "3 agents, 1 active" is explorable), and deleted agents
// that spent money inside it.
export async function adminAgentUsage(
  window: AdminWindow,
  accountKey?: string | null,
): Promise<AdminAgentUsage[]> {
  const since = windowSince(window);
  const { rows } = await pool.query<
    TokenRow & {
      agent_id: string | null;
      handle: string;
      display_name: string | null;
      workspace_name: string | null;
      model: string | null;
      provider: string | null;
      turns: string;
      cost_usd: string;
      last_active_at: string | null;
    }
  >(
    `with windowed as (
       select coalesce(u.agent_id::text, 'h:' || u.agent_handle) as agent_key,
              max(u.agent_id::text) as agent_id,
              (array_agg(u.agent_handle order by u.created_at desc))[1] as handle,
              max(u.workspace_id::text) as workspace_id,
              ${ACCOUNT_KEY} as key,
              ${TURNS} as turns, ${TOKEN_SUMS},
              max(u.created_at) as last_active_at
         from agent_usage u
        where ($1::timestamptz is null or u.created_at >= $1)
          and ($2::text is null or ${ACCOUNT_KEY} = $2)
        group by 1, 5
     ),
     live as (
       select a.id::text as agent_key, a.id::text as agent_id, a.handle, a.workspace_id::text,
              a.display_name, a.model, a.runner_provider, ${OWNER_KEY} as key
         from participants a ${AGENT_OWNER_LATERAL}
        where a.kind = 'agent' and ($2::text is null or ${OWNER_KEY} = $2)
     )
     select coalesce(l.agent_id, w.agent_id) as agent_id,
            coalesce(l.handle, w.handle) as handle,
            l.display_name, l.model, l.runner_provider as provider,
            ws.name as workspace_name,
            coalesce(w.turns, 0) as turns,
            coalesce(w.input_tokens, 0) as input_tokens,
            coalesce(w.output_tokens, 0) as output_tokens,
            coalesce(w.cache_read_tokens, 0) as cache_read_tokens,
            coalesce(w.cache_write_tokens, 0) as cache_write_tokens,
            coalesce(w.cost_usd, 0) as cost_usd,
            w.last_active_at
       from windowed w
       full outer join live l on l.agent_key = w.agent_key
       left join workspaces ws on ws.id = coalesce(l.workspace_id, w.workspace_id)::uuid
      order by cost_usd desc, handle asc`,
    [since, accountKey ?? null],
  );
  return rows.map((r) => ({
    agentId: r.agent_id,
    handle: r.handle,
    displayName: r.display_name,
    workspaceName: r.workspace_name,
    model: r.model,
    provider: r.provider,
    deleted: r.display_name == null, // no live participant row backing it
    turns: num(r.turns),
    tokens: tokens(r),
    costUsd: num(r.cost_usd),
    lastActiveAt: r.last_active_at,
  }));
}

// The recent-turn tail: one row per (result event, model), newest first.
export async function adminActivity(window: AdminWindow, limit = 50): Promise<AdminActivityItem[]> {
  const since = windowSince(window);
  const { rows } = await pool.query<{
    at: string;
    agent_id: string | null;
    agent_handle: string;
    owner_email: string | null;
    workspace_name: string | null;
    model: string;
    turn_id: string | null;
    tokens: string;
    cost_usd: string;
    duration_ms: number | null;
    ok: boolean;
  }>(
    `select u.created_at as at, u.agent_id, u.agent_handle, u.owner_email, w.name as workspace_name,
            u.model, u.turn_id,
            (u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) as tokens,
            u.cost_usd, u.duration_ms, u.ok
       from agent_usage u
       left join workspaces w on w.id = u.workspace_id
      where ($1::timestamptz is null or u.created_at >= $1)
      order by u.created_at desc, u.id desc
      limit $2`,
    [since, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    at: r.at,
    agentId: r.agent_id,
    agentHandle: r.agent_handle,
    ownerEmail: r.owner_email,
    workspaceName: r.workspace_name,
    model: r.model,
    turnId: r.turn_id,
    tokens: num(r.tokens),
    costUsd: num(r.cost_usd),
    durationMs: r.duration_ms,
    ok: r.ok,
  }));
}
