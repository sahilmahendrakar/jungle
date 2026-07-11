import SwiftUI

// Live work anchored under the message that asked for it — the port of TurnChips.tsx. One
// chip per triggered agent (or per turn, when a follow-up spliced into a running turn);
// running chips carry a live one-line summary, finished ones settle into a quiet ✓/✗, and a
// dispatch still waiting behind a busy agent shows a neutral "queued" chip. Tap-through to
// the Activity view lands in M3.
struct MessageTurnChips: View {
    @Environment(AppStore.self) private var store
    let messageId: String
    var onOpenTurn: ((TurnChipData) -> Void)? = nil

    var body: some View {
        // Reading liveVersion subscribes this row to the throttled (~4/s) live tick.
        let _ = store.liveTurns.liveVersion
        let turns = store.liveTurns.turnChips.values
            .filter { $0.messageIds.contains(messageId) }
            .sorted { $0.startedAt < $1.startedAt }
        let queued = store.liveTurns.queued[messageId]

        if !turns.isEmpty || queued != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let queued {
                    QueuedChipView(agentHandle: handle(for: queued.agentId))
                }
                ForEach(turns, id: \.turnId) { turn in
                    TurnChipView(turn: turn, agentHandle: handle(for: turn.agentId))
                        .onTapGesture {
                            if let onOpenTurn {
                                onOpenTurn(turn)
                            } else {
                                // Default click-through: the Activity view for that agent.
                                store.activitySheetAgentId = turn.agentId
                            }
                        }
                }
            }
            .padding(.top, 3)
        }
    }

    private func handle(for agentId: String) -> String {
        store.people.first { $0.id == agentId }?.handle ?? "agent"
    }
}

private struct TurnChipView: View {
    let turn: TurnChipData
    let agentHandle: String

    var body: some View {
        HStack(spacing: 6) {
            if turn.done {
                Image(systemName: turn.ok == false ? "xmark" : "checkmark")
                    .font(.caption2.bold())
                    .foregroundStyle(turn.ok == false ? JungleTheme.destructive : JungleTheme.primary)
            } else {
                WorkingDots()
            }
            (Text("@\(agentHandle) ").fontWeight(.medium).foregroundColor(JungleTheme.foreground)
                + Text(statusText).foregroundColor(JungleTheme.mutedForeground))
                .font(.caption)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            turn.done ? AnyShapeStyle(JungleTheme.muted) : AnyShapeStyle(JungleTheme.primary.opacity(0.05)),
            in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(turn.done ? JungleTheme.border : JungleTheme.primary.opacity(0.3), lineWidth: 1))
    }

    private var statusText: String {
        if turn.done {
            let verb = turn.ok == false ? "failed" : "finished"
            if let ms = turn.durationMs {
                let secs = ms >= 60_000
                    ? String(format: "%.0fs", Double(ms) / 1000)
                    : String(format: "%.1fs", Double(ms) / 1000)
                return "\(verb) · \(secs)"
            }
            return verb
        }
        let items = SdkEvents.buildItems(turn.events)
        return items.isEmpty ? "starting…" : SdkEvents.liveSummary(items)
    }
}

// A dispatch waiting behind a turn already in progress — nothing to click through to yet.
private struct QueuedChipView: View {
    let agentHandle: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock")
                .font(.caption2)
                .foregroundStyle(.secondary)
            (Text("@\(agentHandle) ").fontWeight(.medium).foregroundColor(.primary)
                + Text("queued…").foregroundColor(.secondary))
                .font(.caption)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}
