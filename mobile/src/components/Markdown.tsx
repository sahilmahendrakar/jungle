// Message-body markdown renderer (GFM) — the RN analogue of frontend/src/Markdown.tsx.
// react-native-markdown-display (markdown-it based) does the parsing; we override two rules:
//   - `link`  → "@handle" runs (rewritten to a `mention:` pseudo-link by preprocessMentions, or
//               written as real link syntax by agents) render as a jade badge when the handle
//               resolves to a known participant; otherwise a normal jade link opening in-browser.
//   - `fence`/`code_block` → a bordered monospace block, syntax-highlighted via lib/highlight.
import { useMemo } from "react";
import { Linking, Text } from "react-native";
import MarkdownDisplay from "react-native-markdown-display";
import type { Participant } from "../lib/api";
import { useTheme } from "../lib/theme-context";
import { radius } from "../theme";
import { highlightToNodes } from "../lib/highlight";

// Same charset as the backend's resolveMentions regex (handles may contain hyphens).
const MENTION_RE = /(^|[^a-zA-Z0-9_@/])@([a-zA-Z0-9_-]+)/g;

// Rewrite bare "@handle" runs to `[@handle](mention:handle)` so the link rule can badge them.
// Skips fenced blocks and inline code (so mentions inside code are left alone) and text that's
// already part of a markdown link. Only rewrites handles we know about.
export function preprocessMentions(body: string, known: Set<string>): string {
  if (!body || known.size === 0) return body;
  // Split on fenced code blocks and inline code, transforming only the non-code segments.
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // code segment — leave untouched
      return seg.replace(MENTION_RE, (m, pre, handle) => {
        if (!known.has(handle)) return m;
        // Don't rewrite if this looks like it's already inside link syntax `](...`.
        return `${pre}[@${handle}](mention:${handle})`;
      });
    })
    .join("");
}

function styleMap(c: ReturnType<typeof useTheme>["colors"]) {
  return {
    body: { color: c.foreground, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 0 },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    s: { textDecorationLine: "line-through" as const },
    link: { color: c.primary, textDecorationLine: "underline" as const },
    heading1: { fontSize: 19, fontWeight: "800" as const, marginTop: 10, marginBottom: 2, color: c.foreground },
    heading2: { fontSize: 17, fontWeight: "800" as const, marginTop: 10, marginBottom: 2, color: c.foreground },
    heading3: { fontSize: 15, fontWeight: "700" as const, marginTop: 8, marginBottom: 2, color: c.foreground },
    heading4: { fontSize: 15, fontWeight: "700" as const, marginTop: 6, color: c.foreground },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 1 },
    bullet_list_icon: { color: c.mutedForeground },
    ordered_list_icon: { color: c.mutedForeground },
    blockquote: {
      borderLeftWidth: 2,
      borderLeftColor: c.border,
      backgroundColor: "transparent",
      paddingLeft: 10,
      marginVertical: 2,
    },
    code_inline: {
      backgroundColor: c.muted,
      color: c.foreground,
      fontFamily: "Menlo",
      fontSize: 13,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    fence: {
      backgroundColor: c.muted,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: 12,
      marginVertical: 4,
      fontFamily: "Menlo",
      fontSize: 12.5,
      color: c.foreground,
    },
    code_block: {
      backgroundColor: c.muted,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: 12,
      marginVertical: 4,
      fontFamily: "Menlo",
      fontSize: 12.5,
      color: c.foreground,
    },
    hr: { backgroundColor: c.border, height: 1, marginVertical: 8 },
    table: { borderColor: c.border, borderWidth: 1, borderRadius: 6, marginVertical: 4 },
    thead: { backgroundColor: c.muted },
    th: { padding: 6, borderColor: c.border },
    td: { padding: 6, borderColor: c.border },
    tr: { borderColor: c.border, borderBottomWidth: 1 },
  };
}

export function Markdown({
  children,
  personByHandle,
  onOpenProfile,
}: {
  children: string;
  personByHandle?: (handle: string) => Participant | undefined;
  onOpenProfile?: (id: string) => void;
}) {
  const { colors, resolved } = useTheme();

  const styles = useMemo(() => styleMap(colors), [colors]);

  const rules = useMemo(
    () => ({
      // Mention badge vs. normal link.
      link: (node: any, childrenNodes: any, _parent: any, s: any) => {
        const href: string = node.attributes?.href ?? "";
        const isMention = href.startsWith("mention:");
        const handle = isMention ? href.slice("mention:".length) : null;
        if (handle) {
          const person = personByHandle?.(handle);
          if (!person) return <Text key={node.key}>@{handle}</Text>;
          return (
            <Text
              key={node.key}
              onPress={() => onOpenProfile?.(person.id)}
              style={{
                color: colors.primary,
                backgroundColor: colors.primary + "1A",
                fontWeight: "600",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              {" "}
              @{person.display_name}{" "}
            </Text>
          );
        }
        return (
          <Text key={node.key} style={s.link} onPress={() => href && Linking.openURL(href).catch(() => {})}>
            {childrenNodes}
          </Text>
        );
      },
      // Syntax-highlighted fenced code.
      fence: (node: any, _c: any, _p: any, s: any) => {
        let content: string = node.content ?? "";
        if (content.endsWith("\n")) content = content.slice(0, -1);
        const lang: string | undefined = node.sourceInfo || undefined;
        return (
          <Text key={node.key} style={s.fence}>
            {highlightToNodes(content, lang, resolved)}
          </Text>
        );
      },
    }),
    [colors, resolved, personByHandle, onOpenProfile],
  );

  return (
    <MarkdownDisplay style={styles as any} rules={rules as any}>
      {children}
    </MarkdownDisplay>
  );
}
