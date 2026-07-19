import type { ActivityFilters, DeliverableKind } from "@jungle/shared";

// The composable filter-token language shared by the Activity feed (/api/activity) and message
// search (/api/search): "deploy from:@pip in:#general is:sent" means what it reads like. Unknown
// `key:value` tokens and plain words fall through to free text (full-text matched), so a query
// like "http://…" or "note: check this" never breaks.
//
//   from:@pip            sender
//   to:@sahil            mentioned them, or in your DM with them
//   in:#general          channel; in:@pip means your DM with pip
//   is:sent|received|mentioned   direction, relative to the requester
//   type:messages|deliverables   which feed (Activity page only; search treats it as a switch)
//   kind:pr|issue|doc|…  deliverable kind (aliases below)

const KIND_ALIASES: Record<string, DeliverableKind> = {
  pr: "github_pr",
  issue: "github_issue",
  github: "github",
  notion: "notion",
  doc: "google_doc",
  gdoc: "google_doc",
  drive: "google_drive",
  linear: "linear",
  granola: "granola",
};

// Strip one leading @ or # so "@pip"/"pip" and "#general"/"general" parse the same.
function bare(v: string): string {
  return v.replace(/^[@#]+/, "");
}

export function parseFilterQuery(q: string): ActivityFilters {
  const filters: ActivityFilters = { type: "all" };
  const text: string[] = [];
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^([a-z]+):(\S+)$/i);
    if (!m) {
      text.push(tok);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2];
    switch (key) {
      case "from":
        filters.from = bare(value).toLowerCase();
        break;
      case "to":
        filters.to = bare(value).toLowerCase();
        break;
      case "in":
        if (value.startsWith("@")) filters.inDm = bare(value).toLowerCase();
        else filters.inChannel = bare(value).toLowerCase();
        break;
      case "is": {
        const v = value.toLowerCase();
        if (v === "sent") filters.direction = "sent";
        else if (v === "received") filters.direction = "received";
        else if (v === "mention" || v === "mentioned") filters.direction = "mentions";
        else text.push(tok); // is:purple etc. — not ours, treat as text
        break;
      }
      case "type": {
        const v = value.toLowerCase();
        if (v === "message" || v === "messages") filters.type = "messages";
        else if (v === "deliverable" || v === "deliverables") filters.type = "deliverables";
        else text.push(tok);
        break;
      }
      case "kind": {
        const k = KIND_ALIASES[value.toLowerCase()];
        if (k) filters.kind = k;
        else text.push(tok);
        break;
      }
      default:
        text.push(tok);
    }
  }
  const remainder = text.join(" ").trim();
  if (remainder) filters.text = remainder;
  return filters;
}
