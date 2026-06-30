import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css"; // token colors for fenced code blocks
import { cn } from "@/lib/utils";

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

// Renders message bodies as GitHub-flavored markdown: links, code blocks (highlighted),
// headers, lists, tables, blockquotes, etc. Raw HTML is intentionally NOT enabled, so this is
// XSS-safe. Element styling is done with Tailwind arbitrary-variant selectors on the wrapper.
export function Markdown({ children, className }: { children: string; className?: string }) {
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
