// Shared rendering for the message-context strings fed to an agent's turn input. getRecentContext
// (channel) and getThreadContext (thread) select the same columns with different WHERE clauses,
// then format each row identically. Rows come newest-first; this reverses to oldest-first.
// Internal to the db layer (not re-exported from db/index).
export interface ContextRow {
  handle: string;
  body: string;
  att: string[] | null;
  seq?: string; // present when the caller needs a beforeSeq cursor to page further back
}

export function formatContextLines(rows: ContextRow[]): string {
  return rows
    .reverse()
    .map((r) => `@${r.handle}: ${r.body}${r.att?.length ? ` [attached: ${r.att.join(", ")}]` : ""}`)
    .join("\n");
}

// The oldest row's seq in a NEWEST-FIRST rows array (i.e. before formatContextLines reverses it
// in place) — pass as `beforeSeq` to fetch the page further back. Null once nothing is older.
export function oldestSeqOf(rows: ContextRow[]): string | null {
  return rows.length ? (rows[rows.length - 1].seq ?? null) : null;
}
