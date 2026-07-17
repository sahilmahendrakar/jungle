import Foundation

// Chat-adjacent endpoint groups: members, confirmations, deliverables, turn chips, search.
// Mirrors frontend/src/api.ts.

extension APIClient {
    // Upload a file (upload-first, Slack-style): returns the stored Attachment whose id is
    // then referenced by the WS post frame's attachmentIds. Max 25 MB per file.
    func uploadAttachment(data: Data, filename: String, mime: String) async throws -> Attachment {
        try await request(
            "/api/attachments?filename=\(filename.queryEncoded)&mime=\(mime.queryEncoded)",
            .init(method: "POST", rawBody: data, errorMessage: "upload failed"))
    }

    // Open (or reuse) a DM with another participant.
    func openDM(otherId: String, participantId: String) async throws -> Channel {
        struct Body: Encodable {
            var participantId: String
            var otherId: String
        }
        return try await request(
            "/api/dms",
            .init(jsonBody: Body(participantId: participantId, otherId: otherId), errorMessage: "failed to open DM"))
    }

    func listChannelMembers(channelId: String) async throws -> [Participant] {
        try await request("/api/channels/\(channelId)/members", .init(errorMessage: "failed to load members"))
    }

    // Approve or deny a pending tool confirmation. A 404 means it already resolved/expired
    // (the server auto-denies after its timeout) — callers refresh quietly, not loudly.
    func confirmToolCall(confirmId: String, decision: String) async throws {
        struct Body: Encodable {
            var confirmId: String
            var decision: String
        }
        try await requestVoid(
            "/api/agents/confirm",
            .init(jsonBody: Body(confirmId: confirmId, decision: decision), errorMessage: "failed to submit decision"))
    }

    // Every confirmation still awaiting my decision. Called on load/reconnect to rebuild the
    // approvals badge/inbox (the WS fan-out only reaches sockets open at request time).
    func listPendingConfirms() async throws -> [ToolConfirmation] {
        struct Response: Decodable {
            var confirmations: [ToolConfirmation]
        }
        let r: Response = try await request("/api/confirmations", .init(errorMessage: "failed to load approvals"))
        return r.confirmations
    }

    // My deliverables feed, newest first. Page backwards with `before` = smallest id held.
    func listDeliverables(before: Int? = nil, limit: Int? = nil) async throws -> [Deliverable] {
        struct Response: Decodable {
            var deliverables: [Deliverable]
        }
        var qs: [String] = []
        if let before { qs.append("before=\(before)") }
        if let limit { qs.append("limit=\(limit)") }
        let q = qs.isEmpty ? "" : "?" + qs.joined(separator: "&")
        let r: Response = try await request("/api/deliverables\(q)", .init(errorMessage: "failed to load deliverables"))
        return r.deliverables
    }

    // Durable turn chips for a channel (hydrates chips on channel open; live updates ride the WS).
    func getChannelTurnChips(channelId: String) async throws -> (turns: [TurnChipRow], queued: [QueuedChipRow]) {
        struct Response: Decodable {
            var turns: [TurnChipRow]
            var queued: [QueuedChipRow]
        }
        let r: Response = try await request(
            "/api/channels/\(channelId)/turn-chips", .init(errorMessage: "failed to load turn chips"))
        return (turns: r.turns, queued: r.queued)
    }

    // Full-text message search across my channels.
    func searchMessages(query: String, limit: Int = 20) async throws -> [SearchResult] {
        struct Response: Decodable {
            var results: [SearchResult]
        }
        let r: Response = try await request(
            "/api/search?q=\(query.queryEncoded)&limit=\(limit)", .init(errorMessage: "search failed"))
        return r.results
    }
}
