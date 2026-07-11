import SwiftUI
import MarkdownUI
import Highlightr

// Message-body markdown — the native counterpart of frontend/src/components/Markdown.tsx:
// GFM via MarkdownUI, code highlighting via Highlightr (the same highlight.js grammars the
// web's rehype-highlight uses), and @mentions rewritten into mention:// links rendered as
// tinted badges. Raw HTML is not rendered (MarkdownUI ignores it), matching the web's
// XSS-safe setup.
struct MarkdownText: View {
    let text: String
    // Handles that are real participants — only these become mention badges (same rule as
    // the web, which checks the workspace people list).
    let mentionHandles: Set<String>

    var body: some View {
        Markdown(Self.rewriteMentions(in: text, validHandles: mentionHandles))
            .markdownTheme(.jungleChat)
            .markdownCodeSyntaxHighlighter(HighlightrSyntaxHighlighter.shared)
            .textSelection(.enabled)
    }

    // Rewrite `@handle` text runs into [​@handle](mention://handle) links, skipping code
    // (inline spans and fences) — the port of Markdown.tsx's remark plugin, done as string
    // preprocessing since MarkdownUI has no AST plugins. The scanner walks the raw markdown
    // tracking backtick state so mentions inside code stay literal.
    static func rewriteMentions(in text: String, validHandles: Set<String>) -> String {
        guard text.contains("@"), !validHandles.isEmpty else { return text }
        var out = String()
        out.reserveCapacity(text.count + 32)
        let chars = Array(text)
        var i = 0
        var inFence = false // ``` … ```
        var inSpan = false // ` … `

        func isHandleChar(_ c: Character) -> Bool {
            c.isLetter && c.isASCII || c.isNumber || c == "_" || c == "-"
        }

        while i < chars.count {
            let c = chars[i]
            // Fence toggling: a run of 3+ backticks.
            if c == "`" {
                var run = 0
                while i + run < chars.count && chars[i + run] == "`" { run += 1 }
                if run >= 3 {
                    inFence.toggle()
                } else if !inFence {
                    inSpan.toggle()
                }
                out.append(contentsOf: chars[i..<(i + run)])
                i += run
                continue
            }
            if c == "@", !inFence, !inSpan {
                // An @ at the start or after a non-handle character opens a candidate mention.
                let prevOK = i == 0 || !isHandleChar(chars[i - 1])
                if prevOK {
                    var j = i + 1
                    while j < chars.count && isHandleChar(chars[j]) { j += 1 }
                    let handle = String(chars[(i + 1)..<j]).lowercased()
                    if !handle.isEmpty && validHandles.contains(handle) {
                        out += "[@\(handle)](mention://\(handle))"
                        i = j
                        continue
                    }
                }
            }
            out.append(c)
            i += 1
        }
        return out
    }
}

// MarkdownUI theme approximating the web chat's message styling.
extension MarkdownUI.Theme {
    static let jungleChat = MarkdownUI.Theme()
        .text {
            FontSize(17)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.85))
            BackgroundColor(Color(.secondarySystemFill))
        }
        .link {
            ForegroundColor(.accentColor)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .relativeLineSpacing(.em(0.2))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.85))
                    }
                    .padding(10)
            }
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .markdownMargin(top: .em(0.4), bottom: .em(0.4))
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(.quaternary).frame(width: 3)
                }
        }
}

// Highlightr-backed syntax highlighting for fenced code blocks, with a cache — highlighting
// is CPU-heavy and message views re-render.
final class HighlightrSyntaxHighlighter: CodeSyntaxHighlighter {
    static let shared = HighlightrSyntaxHighlighter()

    private let highlightr: Highlightr?
    private let cache = NSCache<NSString, NSAttributedString>()

    private init() {
        highlightr = Highlightr()
        highlightr?.setTheme(to: "xcode")
    }

    func highlightCode(_ code: String, language: String?) -> Text {
        guard let highlightr else { return Text(code) }
        let key = "\(language ?? "")\u{0}\(code)" as NSString
        let highlighted: NSAttributedString
        if let cached = cache.object(forKey: key) {
            highlighted = cached
        } else if let lang = language, !lang.isEmpty,
                  highlightr.supportedLanguages().contains(lang.lowercased()),
                  let result = highlightr.highlight(code, as: lang.lowercased()) {
            cache.setObject(result, forKey: key)
            highlighted = result
        } else if let result = highlightr.highlight(code) {
            cache.setObject(result, forKey: key)
            highlighted = result
        } else {
            return Text(code)
        }
        var attributed = AttributedString(highlighted)
        // Drop Highlightr's baked-in font/background so the theme's monospaced style applies.
        attributed.font = nil
        attributed.backgroundColor = nil
        return Text(attributed)
    }
}
