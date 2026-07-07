// Deliverable link recognition, shared by the backend (which records deliverables when an agent's
// message lands — services/deliverables.ts) and the frontend (which renders inline artifact cards
// from the same classification, so what the feed records and what the timeline highlights agree).

import type { DeliverableKind } from "./domain.js";

export interface ExtractedLink {
  url: string;
  title: string | null; // the markdown link text, when the agent gave one
  kind: DeliverableKind;
}

// Classify a URL as a work artifact, or null for anything that isn't one (bare repo/profile
// links, marketing pages, …). Deliberately conservative: the Deliverables feed should read as
// "what got shipped", not "every link an agent pasted". (Parsed with a regex, not `URL` — this
// package stays free of DOM/Node globals.)
export function classifyDeliverableUrl(raw: string): DeliverableKind | null {
  const parsed = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(raw);
  if (!parsed) return null;
  const host = parsed[1].toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  const path = parsed[2] || "/";
  if (host === "github.com") {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+/.test(path)) return "github_pr";
    if (/^\/[^/]+\/[^/]+\/issues\/\d+/.test(path)) return "github_issue";
    if (/^\/[^/]+\/[^/]+\/(commit|compare|releases)\//.test(path)) return "github";
    return null;
  }
  if (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site")) {
    return "notion";
  }
  if (host === "docs.google.com" && /^\/(document|spreadsheets|presentation)\//.test(path)) {
    return "google_doc";
  }
  if (host === "drive.google.com" && path !== "/") return "google_drive";
  if (host === "linear.app" && path.includes("/issue/")) return "linear";
  if (host === "granola.ai" || host.endsWith(".granola.ai")) {
    return path.startsWith("/notes/") || path.startsWith("/p/") ? "granola" : null;
  }
  return null;
}

// Bare URLs pasted mid-sentence usually drag trailing punctuation with them.
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>'"]+$/, "");
}

// Pull the recognizable work-artifact links out of a message body: markdown links first (their
// text becomes the title), then bare URLs. Deduped by URL; a markdown link's title wins over a
// bare re-paste of the same URL.
export function extractDeliverableLinks(body: string): ExtractedLink[] {
  const found = new Map<string, ExtractedLink>();
  for (const m of body.matchAll(/\[([^\]]{1,300})\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = trimUrl(m[2]);
    const kind = classifyDeliverableUrl(url);
    if (kind && !found.has(url)) found.set(url, { url, title: m[1].trim() || null, kind });
  }
  for (const m of body.matchAll(/https?:\/\/[^\s<>"'()[\]]+/g)) {
    const url = trimUrl(m[0]);
    if (found.has(url)) continue;
    const kind = classifyDeliverableUrl(url);
    if (kind) found.set(url, { url, title: null, kind });
  }
  return [...found.values()];
}
