import Foundation

// Agent endpoints: memory, config, lifecycle (interrupt/compact/clear), activity events.
// Mirrors frontend/src/api.ts.

struct AgentEventsPage: Decodable, Sendable {
    var events: [AgentEvent] // oldest-first within the page
    var runner: Runner

    struct Runner: Decodable, Sendable {
        var connected: Bool
        var state: String // "idle" | "running"
        var status: AgentStatus?
    }
}

struct AgentActionResult: Decodable, Sendable {
    var ok: Bool
    var waking: Bool?
    var error: String?
}

extension APIClient {
    // The agent's long-term memory (MEMORY.md mirror). Fetched on demand — it doesn't ride in
    // participant payloads.
    func getAgentMemory(id: String) async throws -> (memory: String?, updatedAt: String?) {
        struct Response: Decodable {
            var memory: String?
            var updatedAt: String?
        }
        let r: Response = try await request("/api/agents/\(id)/memory", .init(errorMessage: "failed to load memory"))
        return (memory: r.memory, updatedAt: r.updatedAt)
    }

    // Update an agent's editable config. `mode` applies live; `model`/`persona` at the next
    // turn boundary; empty persona clears it.
    func updateAgent(
        id: String,
        displayName: String? = nil,
        mode: String? = nil,
        model: String? = nil,
        effort: String? = nil,
        persona: String? = nil
    ) async throws -> Participant {
        struct Body: Encodable {
            var displayName: String?
            var mode: String?
            var model: String?
            var effort: String?
            var persona: String?
        }
        return try await request(
            "/api/agents/\(id)",
            .init(method: "PATCH",
                  jsonBody: Body(displayName: displayName, mode: mode, model: model, effort: effort, persona: persona),
                  errorMessage: "failed to update agent"))
    }

    // Permanently delete an agent: tears down its runner and removes its DMs/messages.
    func deleteAgent(id: String) async throws {
        try await requestVoid("/api/agents/\(id)", .init(method: "DELETE", errorMessage: "failed to delete agent"))
    }

    // A page of an agent's activity transcript. Page backwards with `before` = smallest id held.
    func fetchAgentEvents(id: String, before: Double? = nil, limit: Int? = nil) async throws -> AgentEventsPage {
        var qs: [String] = []
        if let before { qs.append("before=\(Int(before))") }
        if let limit { qs.append("limit=\(limit)") }
        let q = qs.isEmpty ? "" : "?" + qs.joined(separator: "&")
        return try await request("/api/agents/\(id)/events\(q)", .init(errorMessage: "failed to load activity"))
    }

    // Stop the agent's currently-running turn.
    @discardableResult
    func interruptAgent(id: String) async throws -> AgentActionResult {
        try await request("/api/agents/\(id)/interrupt", .init(method: "POST", errorMessage: "failed to stop agent"))
    }

    // Compact/summarize session context at the next idle boundary (waking: true if asleep).
    @discardableResult
    func compactAgent(id: String) async throws -> AgentActionResult {
        try await request("/api/agents/\(id)/compact", .init(method: "POST", errorMessage: "failed to compact context"))
    }

    // Clear the conversation/context window (Claude Code's /clear). Memory files untouched.
    @discardableResult
    func clearAgentContext(id: String) async throws -> AgentActionResult {
        try await request("/api/agents/\(id)/clear", .init(method: "POST", errorMessage: "failed to clear context"))
    }
}
