import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css"; // token colors for fenced code blocks
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractPasteBlocks, splitPastePlaceholders } from "@/lib/pastedText";

// Links open safely in a new tab and are visually highlighted.
const components: Components = {
  a: ({ node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
    />
  ),
};

const wrapperClassName = (className?: string) =>
  cn(
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
  );

// A sent message's abbreviated paste: collapsed by default, expandable to the full text.
function PastedTextBlock({ id, lines, content }: { id: number; lines: number; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="my-1 inline-block w-full align-top" data-testid="pasted-text-block">
      <button
        type="button"
        data-testid="pasted-text-toggle"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        Pasted text #{id} · {lines} lines
      </button>
      {open && (
        <pre
          data-testid="pasted-text-content"
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/60 p-2 font-mono text-[0.85em] leading-relaxed"
        >
          {content}
        </pre>
      )}
    </span>
  );
}

function MarkdownText({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {children}
    </ReactMarkdown>
  );
}

// Renders message bodies as GitHub-flavored markdown: links, code blocks (highlighted),
// headers, lists, tables, blockquotes, etc. Raw HTML is intentionally NOT enabled, so this is
// XSS-safe. Element styling is done with Tailwind arbitrary-variant selectors on the wrapper.
//
// Large pastes ride along as a hidden trailer block (see lib/pastedText.ts) keyed to a
// `[Pasted text #N +L lines]` placeholder in the visible text; those are rendered as a
// collapsed, expandable chip instead of inline markdown.
export function Markdown({ children, className }: { children: string; className?: string }) {
  const { text, pastes } = extractPasteBlocks(children);
  if (pastes.size === 0) {
    return (
      <div className={wrapperClassName(className)}>
        <MarkdownText>{text}</MarkdownText>
      </div>
    );
  }
  const parts = splitPastePlaceholders(text);
  return (
    <div className={wrapperClassName(className)}>
      {parts.map((part, i) =>
        part.type === "paste" ? (
          <PastedTextBlock key={i} id={part.id} lines={part.lines} content={pastes.get(part.id) ?? ""} />
        ) : (
          <MarkdownText key={i}>{part.value}</MarkdownText>
        ),
      )}
    </div>
  );
}
