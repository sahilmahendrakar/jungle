import SwiftUI

// Claude-Code-style rendering of an agent's activity: raw SDK events -> turns -> item rows —
// the native counterpart of activity/Transcript.tsx. Tool calls render as one row with a
// live status, expandable to the full input/result; turns collapse behind a summary header.
struct TranscriptView: View {
    let events: [AgentEvent]
    // Turn ids still running (no result yet) render expanded by default.
    var body: some View {
        let turns = SdkEvents.groupTurns(events)
        LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(Array(turns.enumerated()), id: \.element.turnId) { index, turn in
                TurnSection(turn: turn, expandedByDefault: index == turns.count - 1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

private struct TurnSection: View {
    let turn: TranscriptTurn
    let expandedByDefault: Bool

    @State private var expanded: Bool?

    var body: some View {
        let items = SdkEvents.buildItems(turn.events)
        let isExpanded = expanded ?? expandedByDefault
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded = !isExpanded
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text(SdkEvents.turnSummary(items))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                ForEach(items) { item in
                    ItemRow(item: item)
                }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ItemRow: View {
    let item: TranscriptItem

    var body: some View {
        switch item {
        case .inbound(_, let source, let text):
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: source == "compact" ? "rectangle.compress.vertical" : "arrow.right.circle")
                    .font(.caption)
                    .foregroundStyle(.blue)
                Text(text)
                    .font(.callout)
                    .lineLimit(6)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))

        case .text(_, let text):
            MarkdownText(text: text, mentionHandles: [])
                .font(.callout)

        case .thinking(_, let text):
            ThinkingRow(text: text)

        case .note(_, let text):
            Label(text, systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)

        case .tool(_, let name, let input, let result):
            ToolRow(name: name, input: input, result: result)

        case .result(_, let ok, _, let durationMs, let cost):
            HStack(spacing: 6) {
                Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(ok ? Color.green : Color.red)
                Text(resultLine(ok: ok, durationMs: durationMs, cost: cost))
                    .foregroundStyle(.secondary)
            }
            .font(.caption)

        case .raw(_, let value):
            Text(value.jsonString())
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(4)
        }
    }

    private func resultLine(ok: Bool, durationMs: Int?, cost: Double?) -> String {
        var parts = [ok ? "Done" : "Failed"]
        if let durationMs { parts.append(String(format: "%.1fs", Double(durationMs) / 1000)) }
        if let cost { parts.append(String(format: "$%.4f", cost)) }
        return parts.joined(separator: " · ")
    }
}

private struct ThinkingRow: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        Button {
            expanded.toggle()
        } label: {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "brain")
                    .font(.caption)
                    .foregroundStyle(.purple.opacity(0.7))
                Text(expanded ? text : SdkEvents.clip(text))
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct ToolRow: View {
    let name: String
    let input: JSONValue?
    let result: ToolResultInfo?

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    statusIcon
                    Text(SdkEvents.humanToolName(name))
                        .font(.caption.weight(.semibold).monospaced())
                    Text(target)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                if let input, input.objectValue?.isEmpty == false {
                    CodeBlock(text: SdkEvents.pretty(input))
                }
                if let result {
                    CodeBlock(text: String(result.text.prefix(2000)), tint: result.isError ? .red : nil)
                }
            }
        }
    }

    private var statusIcon: some View {
        Group {
            if let result {
                Image(systemName: result.isError ? "xmark.circle" : "checkmark.circle")
                    .foregroundStyle(result.isError ? Color.red : Color.green)
            } else {
                ProgressView().controlSize(.mini)
            }
        }
        .font(.caption)
    }

    // The clipped one-line "what is this call touching" hint, like the web's tool row.
    private var target: String {
        let command = SdkEvents.inputStr(input, "command")
        if !command.isEmpty { return SdkEvents.clip(command) }
        let path = SdkEvents.inputStr(input, "file_path")
        if !path.isEmpty { return SdkEvents.baseName(path) }
        let pattern = SdkEvents.inputStr(input, "pattern")
        if !pattern.isEmpty { return SdkEvents.clip(pattern) }
        return SdkEvents.clip(SdkEvents.firstString(input) ?? "")
    }
}

private struct CodeBlock: View {
    let text: String
    var tint: Color? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.caption2.monospaced())
                .foregroundStyle(tint ?? .primary)
                .padding(8)
        }
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 6))
    }
}
