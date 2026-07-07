import {
  AudioLines,
  CircleDot,
  ExternalLink,
  FileText,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequest,
  Target,
  type LucideIcon,
} from "lucide-react";
import { extractDeliverableLinks, type DeliverableKind } from "../../api";
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

// Compact artifact cards under an agent message that links real work (a PR, a doc, …).
// Renders nothing when the body has no recognizable artifact links. `className="contents"` so
// each chip is a direct flex item of the shared message footer row (replies, then turn/activity
// chips, then these) instead of nesting its own row inside that row.
export function DeliverableChips({ body, className }: { body: string; className?: string }) {
  const links = extractDeliverableLinks(body);
  if (!links.length) return null;
  return (
    <div data-testid="deliverable-chips" className={cn("contents", className)}>
      {links.map((l) => {
        const meta = DELIVERABLE_KIND_META[l.kind];
        const Icon = meta.icon;
        return (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noreferrer"
            data-testid="deliverable-chip"
            className="group/chip inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs shadow-sm transition-colors hover:border-primary/40 hover:bg-accent"
          >
            <Icon className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-medium">
              {l.title ?? shortDeliverableUrl(l.url)}
            </span>
            <span className="shrink-0 text-muted-foreground">{meta.label}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover/chip:text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
