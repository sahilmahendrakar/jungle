// Deliverable (work-artifact) kind → label + Ionicons glyph, ported from the web
// DELIVERABLE_KIND_META. Plus a URL shortener the feed reuses.
import type { DeliverableKind } from "./api";
import type { IoniconName } from "./icons";

export const DELIVERABLE_KIND_META: Record<DeliverableKind, { label: string; icon: IoniconName }> = {
  github_pr: { label: "Pull request", icon: "git-pull-request-outline" },
  github_issue: { label: "Issue", icon: "alert-circle-outline" },
  github: { label: "GitHub", icon: "logo-github" },
  notion: { label: "Notion", icon: "document-text-outline" },
  google_doc: { label: "Google Doc", icon: "document-text-outline" },
  google_drive: { label: "Drive", icon: "folder-open-outline" },
  linear: { label: "Linear", icon: "locate-outline" },
  granola: { label: "Granola", icon: "mic-outline" },
};

export function shortDeliverableUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "");
  return stripped.length > 64 ? `${stripped.slice(0, 63)}…` : stripped;
}
