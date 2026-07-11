import Foundation

// Pure parsing for the agent Activity transcript: raw Claude Agent SDK stream events -> a
// flat, renderable item model, grouped into turns — a verbatim port of
// frontend/src/components/chat/activity/sdkEvents.ts. SDK event shapes are loosely typed
// (they vary by version), so everything narrows defensively off the `type` discriminant.

struct ToolResultInfo: Hashable {
    var text: String
    var isError: Bool
}

enum TranscriptItem: Identifiable, Hashable {
    case tool(key: String, name: String, input: JSONValue?, result: ToolResultInfo?)
    case text(key: String, text: String)
    case thinking(key: String, text: String)
    case note(key: String, text: String)
    case result(key: String, ok: Bool, text: String?, durationMs: Int?, cost: Double?)
    case raw(key: String, value: JSONValue)
    // A message that fed this agent from outside its own turn loop: the trigger that woke it,
    // a /compact request, or another message delivered to its inbox mid-turn.
    case inbound(key: String, source: String, text: String)

    var id: String {
        switch self {
        case .tool(let key, _, _, _), .text(let key, _), .thinking(let key, _),
             .note(let key, _), .result(let key, _, _, _, _), .raw(let key, _),
             .inbound(let key, _, _):
            return key
        }
    }
}

struct TranscriptTurn: Identifiable {
    var turnId: String
    var events: [AgentEvent]

    var id: String { turnId }
}

enum SdkEvents {
    static let clipLength = 96

    static func pretty(_ v: JSONValue?) -> String {
        guard let v else { return "" }
        if case .string(let s) = v { return s }
        return v.jsonString(pretty: true)
    }

    static func clip(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return "" }
        let line = s.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)[0]
        return line.count > clipLength ? String(line.prefix(clipLength)) + "…" : String(line)
    }

    static func baseName(_ p: String) -> String {
        p.components(separatedBy: "/").last ?? p
    }

    static func inputStr(_ input: JSONValue?, _ key: String) -> String {
        input?[key]?.stringValue ?? ""
    }

    static func firstString(_ input: JSONValue?) -> String? {
        guard let obj = input?.objectValue else { return nil }
        return obj.values.compactMap(\.stringValue).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private static func resultText(_ content: JSONValue?) -> String {
        guard let content else { return "" }
        if case .string(let s) = content { return s }
        if case .array(let items) = content {
            return items.map { item in
                item.stringValue ?? item["text"]?.stringValue ?? pretty(item)
            }.joined(separator: "\n")
        }
        return pretty(content)
    }

    // Merge event pages / live frames by id, keeping ascending (oldest-first) order.
    static func mergeEvents(_ a: [AgentEvent], _ b: [AgentEvent]) -> [AgentEvent] {
        var byId: [Double: AgentEvent] = [:]
        for e in a + b { byId[e.id] = e }
        return byId.values.sorted { $0.id < $1.id }
    }

    // Group ascending events into turns (turn_id), preserving first-seen order.
    static func groupTurns(_ events: [AgentEvent]) -> [TranscriptTurn] {
        var out: [TranscriptTurn] = []
        var indexById: [String: Int] = [:]
        for e in events {
            let key = e.turnId
            if let i = indexById[key] {
                out[i].events.append(e)
            } else {
                indexById[key] = out.count
                out.append(TranscriptTurn(turnId: key, events: [e]))
            }
        }
        return out
    }

    // System subtypes that are pure noise in a human transcript.
    private static let hiddenSystem: Set<String> = ["thinking_tokens", "task_progress", "task_updated"]

    // Flatten a turn's raw SDK events into renderable items. Tool calls pair with their
    // tool_result (by tool_use_id) so each call renders as a single row with a live status.
    static func buildItems(_ events: [AgentEvent]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        // key -> index into items (ToolItem identity for result pairing).
        var toolIndexByUseId: [String: Int] = [:]

        for e in events {
            let ev = e.event
            let type = ev["type"]?.stringValue

            if type == "jungle_inbound" {
                let rawSource = ev["source"]?.stringValue
                let source = (rawSource == "compact" || rawSource == "inbox") ? rawSource! : "trigger"
                items.append(.inbound(key: "\(e.id)", source: source, text: ev["text"]?.stringValue ?? ""))
                continue
            }

            if type == "system" {
                let st = ev["subtype"]?.stringValue ?? ""
                if hiddenSystem.contains(st) { continue }
                let text: String
                if st == "init" {
                    text = "Session started"
                } else if st == "task_started" {
                    let desc = ev["description"]?.stringValue
                    text = "Background task started" + (desc.map { " — \($0)" } ?? "")
                } else if st == "task_notification" {
                    let status = ev["status"]?.stringValue ?? "update"
                    let summary = ev["summary"]?.stringValue
                    text = "Background task \(status)" + (summary.map { " — \($0)" } ?? "")
                } else {
                    text = st.isEmpty ? "system" : st
                }
                items.append(.note(key: "\(e.id)", text: text))
                continue
            }

            if type == "assistant" {
                guard let blocks = ev["message"]?["content"]?.arrayValue else {
                    items.append(.raw(key: "\(e.id)", value: ev))
                    continue
                }
                for (i, b) in blocks.enumerated() {
                    let key = "\(e.id):\(i)"
                    switch b["type"]?.stringValue {
                    case "text":
                        let text = b["text"]?.stringValue ?? ""
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            items.append(.text(key: key, text: text))
                        }
                    case "thinking":
                        let text = b["thinking"]?.stringValue ?? ""
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            items.append(.thinking(key: key, text: text))
                        }
                    case "tool_use":
                        items.append(.tool(
                            key: key,
                            name: b["name"]?.stringValue ?? "tool",
                            input: b["input"] ?? .object([:]),
                            result: nil))
                        if let useId = b["id"]?.stringValue {
                            toolIndexByUseId[useId] = items.count - 1
                        }
                    default:
                        items.append(.raw(key: key, value: b))
                    }
                }
                continue
            }

            if type == "user" {
                guard let blocks = ev["message"]?["content"]?.arrayValue else { continue }
                for (i, b) in blocks.enumerated() {
                    guard b["type"]?.stringValue == "tool_result" else { continue }
                    let res = ToolResultInfo(
                        text: resultText(b["content"]),
                        isError: b["is_error"]?.boolValue == true)
                    if let useId = b["tool_use_id"]?.stringValue,
                       let index = toolIndexByUseId[useId],
                       case .tool(let key, let name, let input, _) = items[index] {
                        items[index] = .tool(key: key, name: name, input: input, result: res)
                    } else {
                        items.append(.tool(key: "\(e.id):\(i)", name: "tool", input: nil, result: res))
                    }
                }
                continue
            }

            if type == "result" {
                items.append(.result(
                    key: "\(e.id)",
                    ok: ev["is_error"]?.boolValue != true && (ev["subtype"]?.stringValue ?? "success") == "success",
                    text: ev["result"]?.stringValue,
                    durationMs: ev["duration_ms"]?.intValue,
                    cost: ev["total_cost_usd"]?.numberValue))
                continue
            }

            items.append(.raw(key: "\(e.id)", value: ev))
        }
        return items
    }

    // Short scannable summary for a collapsed turn header.
    static func turnSummary(_ items: [TranscriptItem]) -> String {
        for item in items.reversed() {
            if case .text(_, let text) = item {
                return clip(stripMarkdown(text))
            }
        }
        let tools = items.filter { if case .tool = $0 { return true } else { return false } }.count
        if tools > 0 { return "\(tools) action\(tools == 1 ? "" : "s")" }
        for item in items {
            if case .note(_, let text) = item { return text }
        }
        return ""
    }

    // "mcp__jungle__send_message" -> "send message"; PascalCase tool names stay as-is.
    static func humanToolName(_ name: String) -> String {
        if let range = name.range(of: #"^mcp__.+?__"#, options: .regularExpression) {
            return String(name[range.upperBound...]).replacingOccurrences(of: "_", with: " ")
        }
        return name.replacingOccurrences(of: "_", with: " ")
    }

    // What the agent is doing RIGHT NOW, for the ambient one-line working indicator.
    static func liveSummary(_ items: [TranscriptItem]) -> String {
        for item in items.reversed() {
            switch item {
            case .tool(_, let name, _, let result):
                return result == nil ? "running \(humanToolName(name))" : "ran \(humanToolName(name))"
            case .thinking:
                return "thinking…"
            case .text(_, let text):
                return clip(stripMarkdown(text))
            default:
                continue
            }
        }
        return "getting started…"
    }

    private static func stripMarkdown(_ s: String) -> String {
        s.replacingOccurrences(of: #"[#*`>]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
