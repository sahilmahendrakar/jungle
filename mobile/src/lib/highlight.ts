// Syntax highlighting for fenced code blocks. Returns React nodes (colored <Text> spans) to drop
// inside the code <Text> in Markdown.tsx. Uses lowlight (highlight.js → hast) walked into spans
// colored by the token map ported from the web's index.css .hljs rules (light + dark). Pure JS,
// no native deps. Falls back to the plain string if the grammar is unknown or anything throws.
import { createElement, type ReactNode } from "react";
import { Text } from "react-native";
import { createLowlight, common } from "lowlight";
import { hljsLight, hljsDark } from "../theme";
import type { ThemeName } from "../theme";

const lowlight = createLowlight(common);

// highlight.js scope (hljs-<class>) → our token color key. Mirrors the index.css grouping.
function colorFor(cls: string, theme: ThemeName): string | undefined {
  const t = theme === "light" ? hljsLight : hljsDark;
  const c = cls.replace(/^hljs-/, "");
  if (["keyword", "selector-tag", "doctag", "section", "template-tag", "deletion"].includes(c))
    return t.keyword;
  if (["title", "title.class_", "title.function_", "name"].some((x) => c.startsWith(x)))
    return t.title;
  if (["string", "regexp", "addition", "attribute", "meta-string"].includes(c)) return t.string;
  if (
    ["number", "literal", "symbol", "bullet", "link", "variable", "template-variable"].includes(c) ||
    c.startsWith("selector-")
  )
    return t.number;
  if (["built_in", "type", "attr", "params", "meta", "punctuation"].includes(c)) return t.builtin;
  if (["comment", "quote"].includes(c)) return t.comment;
  return undefined;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

let keySeq = 0;

function walk(node: HastNode, theme: ThemeName, inherited?: string): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const cls = node.properties?.className?.find((x) => x.startsWith("hljs-"));
    const color = (cls && colorFor(cls, theme)) || inherited;
    const kids = (node.children ?? []).map((ch) => walk(ch, theme, color));
    return createElement(Text, { key: `hl-${keySeq++}`, style: color ? { color } : undefined }, ...kids);
  }
  return "";
}

export function highlightToNodes(code: string, lang: string | undefined, theme: ThemeName): ReactNode {
  try {
    const tree =
      lang && lowlight.registered(lang)
        ? lowlight.highlight(lang, code)
        : lowlight.highlightAuto(code);
    return (tree.children as HastNode[]).map((n) => walk(n, theme));
  } catch {
    return code;
  }
}
