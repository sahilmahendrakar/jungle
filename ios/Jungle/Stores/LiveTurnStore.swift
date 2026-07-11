import Foundation
import Observation

// A bounded, always-on buffer of each agent's CURRENT turn — a verbatim port of
// frontend/src/ws/useLiveTurns.ts. Powers the ambient "what is this agent doing right now"
// surfaces (DM activity strip, roster, sidebar working-dots, trigger-message chips).
//
// Perf shape (the contract that keeps SwiftUI alive at token rate): the dictionaries are
// deliberately NOT observable — ingest mutates them with zero view invalidation — and views
// re-render off `liveVersion`, bumped by a coalescing 250 ms tick. Keep the invariants in
// sync with useLiveTurns.ts.

struct LiveTurn {
    var agentId: String
    var turnId: String
    var context: TurnContext? // nil until a context-carrying frame arrives
    var events: [AgentEvent] // this turn only, oldest-first, capped
    var done: Bool // a result event arrived (kept until the next turn starts)
    var startedAt: Date
}

// Keyed by turn (agentId:turnId), NOT by agent — a channel can hold chips for several of the
// same agent's turns at once. One turn can anchor MULTIPLE messages (a follow-up spliced into
// a running turn joins it) — that's what messageIds captures.
struct TurnChipData {
    var agentId: String
    var turnId: String
    var messageIds: [String]
    var events: [AgentEvent] // live only — empty for a hydrated (reload-recovered) turn
    var done: Bool
    var ok: Bool?
    var durationMs: Int?
    var startedAt: Date
}

// A dispatch waiting in the agent's inbox behind a turn already in progress — no turn_id yet.
struct QueuedTurn {
    var agentId: String
    var messageId: String
    var channelId: String
}

private let maxEventsPerTurn = 300
private let versionThrottleMs = 250

// Parse the SDK's terminal "result" event the same way the Activity transcript does.
func resultFromEvent(_ event: JSONValue) -> (ok: Bool, durationMs: Int?)? {
    guard event["type"]?.stringValue == "result" else { return nil }
    let ok = event["is_error"]?.boolValue != true
        && (event["subtype"]?.stringValue ?? "success") == "success"
    return (ok: ok, durationMs: event["duration_ms"]?.intValue)
}

@MainActor
@Observable
final class LiveTurnStore {
    // Hot path: plain storage, mutated per frame with no SwiftUI invalidation.
    @ObservationIgnored private(set) var liveTurns: [String: LiveTurn] = [:] // by agentId
    @ObservationIgnored private(set) var turnChips: [String: TurnChipData] = [:] // by agentId:turnId
    @ObservationIgnored private(set) var queued: [String: QueuedTurn] = [:] // by messageId

    // The one observable: consumers read this, then pull from the dictionaries above.
    private(set) var liveVersion = 0
    @ObservationIgnored private var flushScheduled = false

    private func turnKey(_ agentId: String, _ turnId: String) -> String {
        "\(agentId):\(turnId)"
    }

    private func bump() {
        guard !flushScheduled else { return }
        flushScheduled = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(versionThrottleMs))
            self.flushScheduled = false
            self.liveVersion += 1
        }
    }

    // `event` is nil for context-only frames (agent_turn).
    func ingestLiveEvent(agentId: String, turnId: String?, event: JSONValue?, context: TurnContext?) {
        guard let turnId else { return }
        // Per-agent "current turn" slot (ambient status surfaces).
        var turn: LiveTurn
        if let existing = liveTurns[agentId], existing.turnId == turnId {
            turn = existing
        } else {
            turn = LiveTurn(agentId: agentId, turnId: turnId, context: nil, events: [], done: false, startedAt: Date())
        }
        if let context, turn.context == nil { turn.context = context }

        // Per-turn chip slot — reused across calls for the same turn, so a splice's later
        // context.messageId ADDS to the anchor set instead of replacing it.
        let key = turnKey(agentId, turnId)
        var chip = turnChips[key] ?? TurnChipData(
            agentId: agentId, turnId: turnId, messageIds: [], events: [],
            done: false, ok: nil, durationMs: nil, startedAt: Date())
        if let messageId = context?.messageId {
            if !chip.messageIds.contains(messageId) { chip.messageIds.append(messageId) }
            // A turn anchored to this message is the live indicator — drop any "queued" chip for
            // it. Runs per frame on purpose (a mid-turn splice emits no dedicated join frame);
            // removing a missing key is a cheap no-op.
            queued.removeValue(forKey: messageId)
        }

        if let event {
            turn.events.append(AgentEvent(
                id: Date().timeIntervalSince1970 * 1000 + Double.random(in: 0..<1),
                turnId: turnId,
                event: event,
                createdAt: ISO8601DateFormatter().string(from: Date())))
            if turn.events.count > maxEventsPerTurn {
                // Keep the head (the inbound trigger orients the turn) and the fresh tail.
                turn.events = Array(turn.events.prefix(5)) + Array(turn.events.suffix(maxEventsPerTurn - 5))
            }
            chip.events = turn.events
            if let result = resultFromEvent(event) {
                turn.done = true
                chip.done = true
                chip.ok = result.ok
                chip.durationMs = result.durationMs
            }
        }

        liveTurns[agentId] = turn
        turnChips[key] = chip
        bump()
    }

    func ingestQueued(agentId: String, context: TurnContext) {
        guard let messageId = context.messageId, let channelId = context.channelId else { return }
        // Invariant: one active chip per (agent, message). If this agent already has a RUNNING
        // turn anchored here, that chip IS the live indicator — don't add a redundant queued one.
        // (A finished turn doesn't count — a new reply after the agent went idle legitimately
        // queues for a fresh turn.)
        for chip in turnChips.values where chip.agentId == agentId && !chip.done && chip.messageIds.contains(messageId) {
            return
        }
        queued[messageId] = QueuedTurn(agentId: agentId, messageId: messageId, channelId: channelId)
        bump()
    }

    // Seed durable (reload-recovered) chip data for a channel; a live/already-hydrated entry
    // always wins, so this never clobbers fresher state that arrived while the fetch was in flight.
    func hydrateChannel(channelId: String, turns: [TurnChipRow], queuedRows: [QueuedChipRow]) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for t in turns {
            let key = turnKey(t.agentId, t.turnId)
            if turnChips[key] != nil { continue } // live (or already-hydrated) data wins
            turnChips[key] = TurnChipData(
                agentId: t.agentId,
                turnId: t.turnId,
                messageIds: t.messageIds,
                events: [],
                done: t.doneAt != nil,
                ok: t.ok,
                durationMs: t.durationMs,
                startedAt: iso.date(from: t.startedAt) ?? Date())
        }
        // Skip a queued chip only when THAT agent has a RUNNING turn anchored to the same
        // message ("anchored to any chip" would hide a legit dispatch behind a finished turn).
        var runningAnchored = Set<String>() // "agentId:messageId" for running chips only
        for chip in turnChips.values where !chip.done {
            for mid in chip.messageIds { runningAnchored.insert("\(chip.agentId):\(mid)") }
        }
        for q in queuedRows {
            if queued[q.messageId] != nil { continue }
            if runningAnchored.contains("\(q.agentId):\(q.messageId)") { continue }
            queued[q.messageId] = QueuedTurn(agentId: q.agentId, messageId: q.messageId, channelId: channelId)
        }
        bump()
    }

    func reset() {
        liveTurns = [:]
        turnChips = [:]
        queued = [:]
        liveVersion += 1
    }
}

// Rows from GET /api/channels/:id/turn-chips (frontend api.ts TurnChipRow/QueuedChipRow).
struct TurnChipRow: Codable, Sendable {
    var turnId: String
    var agentId: String
    var messageIds: [String]
    var startedAt: String
    var doneAt: String?
    var ok: Bool?
    var durationMs: Int?

    enum CodingKeys: String, CodingKey {
        case ok
        case turnId = "turn_id"
        case agentId = "agent_id"
        case messageIds = "message_ids"
        case startedAt = "started_at"
        case doneAt = "done_at"
        case durationMs = "duration_ms"
    }
}

struct QueuedChipRow: Codable, Sendable {
    var agentId: String
    var messageId: String

    enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
        case messageId = "message_id"
    }
}
