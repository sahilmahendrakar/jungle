import { pool } from "./pool";

// Sign-in handshakes for the browser integration (migration 047). The durable half — a logged-in
// profile — is an ordinary `integration_connections` row with integration_key 'browser' and the
// Browserbase context id as its access_token, so it needs no code here: connections.ts already
// creates, lists, and needs_reconnect-flags those.
//
// What lives here is only the short-lived handshake: a human has to sit in front of a live cloud
// browser for up to ~14 minutes while we watch its cookie jar, which is server-side state with no
// other home.

export interface BrowserSigninRequestRow {
  id: string;
  participant_id: string;
  agent_id: string | null;
  site: string;
  context_id: string;
  session_id: string | null;
  status: "pending" | "completed" | "expired" | "failed";
  connection_id: string | null;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

const COLUMNS =
  `id, participant_id, agent_id, site, context_id, session_id, status, connection_id,
   expires_at, created_at, completed_at`;

export async function createBrowserSigninRequest(r: {
  participantId: string;
  agentId: string | null;
  site: string;
  contextId: string;
  sessionId: string | null;
  expiresAt: Date;
}): Promise<BrowserSigninRequestRow> {
  const { rows } = await pool.query<BrowserSigninRequestRow>(
    `insert into browser_signin_requests
       (participant_id, agent_id, site, context_id, session_id, expires_at)
     values ($1,$2,$3,$4,$5,$6)
     returning ${COLUMNS}`,
    [r.participantId, r.agentId, r.site, r.contextId, r.sessionId, r.expiresAt],
  );
  return rows[0];
}

export async function getBrowserSigninRequest(id: string): Promise<BrowserSigninRequestRow | null> {
  const { rows } = await pool.query<BrowserSigninRequestRow>(
    `select ${COLUMNS} from browser_signin_requests where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function updateBrowserSigninRequest(
  id: string,
  patch: {
    status?: BrowserSigninRequestRow["status"];
    sessionId?: string | null;
    connectionId?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  // $1 is always the id, so a value pushed at index n binds to $(n+2). Deriving the placeholder
  // from vals.length after the push (rather than from sets.length) keeps the two in step even
  // though some clauses below add SQL without adding a parameter.
  const bind = (v: unknown): string => {
    vals.push(v);
    return `$${vals.length + 1}`;
  };
  if (patch.status !== undefined) {
    sets.push(`status = ${bind(patch.status)}`);
    // A terminal status stamps completed_at once; re-running the sweeper must not move it.
    if (patch.status !== "pending") sets.push(`completed_at = coalesce(completed_at, now())`);
  }
  if (patch.sessionId !== undefined) sets.push(`session_id = ${bind(patch.sessionId)}`);
  if (patch.connectionId !== undefined) sets.push(`connection_id = ${bind(patch.connectionId)}`);
  if (!sets.length) return;
  await pool.query(`update browser_signin_requests set ${sets.join(", ")} where id = $1`, [id, ...vals]);
}

// The most recent still-open request for a person+site, so a second browser_signin call reuses the
// live session instead of opening another one (each costs against the Browserbase allowance, and
// two live views for one login is just confusing).
export async function findOpenBrowserSigninRequest(
  participantId: string,
  site: string,
): Promise<BrowserSigninRequestRow | null> {
  const { rows } = await pool.query<BrowserSigninRequestRow>(
    `select ${COLUMNS} from browser_signin_requests
      where participant_id = $1 and site = $2 and status = 'pending' and expires_at > now()
      order by created_at desc limit 1`,
    [participantId, site],
  );
  return rows[0] ?? null;
}

// Sweeper: mark timed-out handshakes expired. Returns the rows it closed so the caller can release
// their Browserbase sessions and fan out the state change (an abandoned session bills until its
// own timeout, and on the free tier a handful of those is the entire monthly allowance).
export async function expireStaleBrowserSigninRequests(): Promise<BrowserSigninRequestRow[]> {
  const { rows } = await pool.query<BrowserSigninRequestRow>(
    `update browser_signin_requests
        set status = 'expired', completed_at = now()
      where status = 'pending' and expires_at <= now()
      returning ${COLUMNS}`,
  );
  return rows;
}
