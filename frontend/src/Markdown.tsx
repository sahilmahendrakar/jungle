import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { visitParents } from "unist-util-visit-parents";
import type { Root, Text } from "mdast";
import "highlight.js/styles/github.css"; // token colors for fenced code blocks
import { cn } from "@/lib/utils";
import type { Participant } from "./api";

// Same charset as the backend's resolveMentions regex (handles may contain hyphens), so a
// mention badge renders for exactly the text that would have @mentioned/triggered someone.
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

// Rewrites "@handle" runs in text nodes into mdast links with a "mention:" pseudo-scheme, so
// the existing `a` renderer can special-case them into badges. Only touches "text" nodes —
// code spans/fences are separate mdast node types, so mentions inside code are left alone.
// Skips text already inside a link (e.g. GFM's autolink for "foo@example.com") so we don't
// nest a mention-link inside an existing one.
interface HasChildren {
  type: string;
  children: unknown[];
}

function remarkMentions() {
  return (tree: Root) => {
    visitParents(tree, "text", (node: Text, ancestors) => {
      const parent = ancestors[ancestors.length - 1] as unknown as HasChildren | undefined;
      const index = parent ? parent.children.indexOf(node) : -1;
      if (!parent || index < 0 || ancestors.some((a) => a.type === "link")) return;
      MENTION_RE.lastIndex = 0;
      if (!MENTION_RE.test(node.value)) return;
      const children: (Text | { type: "link"; url: string; children: Text[] })[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      MENTION_RE.lastIndex = 0;
      while ((match = MENTION_RE.exec(node.value))) {
        if (match.index > last) children.push({ type: "text", value: node.value.slice(last, match.index) });
        children.push({
          type: "link",
          url: `mention:${match[1]}`,
          children: [{ type: "text", value: match[0] }],
        });
        last = match.index + match[0].length;
      }
      if (last < node.value.length) children.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}

// Renders message bodies as GitHub-flavored markdown: links, code blocks (highlighted),
// headers, lists, tables, blockquotes, etc. Raw HTML is intentionally NOT enabled, so this is
// XSS-safe. Element styling is done with Tailwind arbitrary-variant selectors on the wrapper.
export function Markdown({
  children,
  className,
  personByHandle,
  onOpenProfile,
}: {
  children: string;
  className?: string;
  // When provided, "@handle" runs that resolve to a known participant render as a clickable
  // badge (Slack-style) instead of plain text; unknown handles stay plain text either way.
  personByHandle?: (handle: string) => Participant | undefined;
  onOpenProfile?: (id: string) => void;
}) {
  const components: Components = {
    a: ({ href, children, ...props }) => {
      if (href?.startsWith("mention:")) {
        const handle = href.slice("mention:".length);
        const person = personByHandle?.(handle);
        if (!person) return <>@{handle}</>;
        return (
          <button
            type="button"
            data-testid="mention-badge"
            onClick={() => onOpenProfile?.(person.id)}
            className="rounded px-1 py-0.5 align-baseline font-medium text-primary bg-primary/10 hover:bg-primary/20"
          >
            @{person.display_name}
          </button>
        );
      }
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-foreground/90",
        // spacing between blocks (tight; chat messages aren't documents)
        "[&>*]:my-0 [&>*+*]:mt-2",
        // headers
        "[&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-bold",
        "[&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-bold",
        "[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold",
        // lists
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
        // blockquote
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        // inline code (code not inside a pre)
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
        // fenced code blocks
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/60 [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre]:leading-relaxed",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-mono",
        // tables (GFM)
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        // misc
        "[&_hr]:my-3 [&_hr]:border-border [&_strong]:font-semibold",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
