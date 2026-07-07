import {
  AudioLines,
  CircleDot,
  FileText,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequest,
  Target,
  type LucideIcon,
} from "lucide-react";
import { extractDeliverableLinks, type DeliverableKind, type ExtractedLink } from "../../api";
import { cn } from "@/lib/utils";

// Shared presentation for deliverables (work artifacts agents ship): kind → icon/label, the
// compact inline chips under agent messages, and the URL shortener the feed reuses. The link
// classification itself lives in @jungle/shared so these chips agree with what the backend records.

export const DELIVERABLE_KIND_META: Record<DeliverableKind, { label: string; icon: LucideIcon }> = {
  github_pr: { label: "Pull request", icon: GitPullRequest },
  github_issue: { label: "Issue", icon: CircleDot },
  github: { label: "GitHub", icon: GitCommitHorizontal },
  notion: { label: "Notion", icon: FileText },
  google_doc: { label: "Google Doc", icon: FileText },
  google_drive: { label: "Drive", icon: FolderOpen },
  linear: { label: "Linear", icon: Target },
  granola: { label: "Granola", icon: AudioLines },
};

// "github.com/acme/app/pull/42" — enough to recognize the artifact without the noise.
export function shortDeliverableUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "");
  return stripped.length > 64 ? `${stripped.slice(0, 63)}…` : stripped;
}

// The chip's own label: "owner/repo #42" for a GitHub PR/issue (repo + number, no full URL) —
// the common case and worth optimizing for compactness; everything else falls back to the
// agent-given title or a shortened URL.
function chipLabel(l: ExtractedLink): string {
  if (l.kind === "github_pr" || l.kind === "github_issue") {
    const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(l.url);
    if (m) return `${m[1]} #${m[2]}`;
  }
  return l.title ?? shortDeliverableUrl(l.url);
}

// Compact artifact chips linking real work (a PR, a doc, …) a thread produced. Renders nothing
// for an empty list. `className="contents"` so each chip is a direct flex item of the shared
// message footer row (replies, then turn/activity chips, then these) instead of nesting its own
// row inside that row.
export function DeliverableLinkChips({ links, className }: { links: ExtractedLink[]; className?: string }) {
  if (!links.length) return null;
  return (
    <div data-testid="deliverable-chips" className={cn("contents", className)}>
      {links.map((l) => {
        const Icon = DELIVERABLE_KIND_META[l.kind].icon;
        return (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noreferrer"
            data-testid="deliverable-chip"
            className="inline-flex max-w-full items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px] shadow-sm transition-colors hover:border-primary/40 hover:bg-accent"
          >
            <Icon className="size-3 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-medium">{chipLabel(l)}</span>
          </a>
        );
      })}
    </div>
  );
}

// Convenience wrapper for the common case of a single message body (extracts its links inline).
export function DeliverableChips({ body, className }: { body: string; className?: string }) {
  return <DeliverableLinkChips links={extractDeliverableLinks(body)} className={className} />;
}
