import Foundation

// Endpoint groups used by the app shell (identity, channels, participants, messages).
// Mirrors the corresponding functions in frontend/src/api.ts; more groups arrive with the
// screens that need them.

extension APIClient {
    // --- Identity / workspaces ---

    // GET /api/me: the signed-in Google account and every workspace it belongs to.
    // Firebase-only (no dev bypass), matching api.ts me().
    func me() async throws -> Me {
        try await request("/api/me", .init(devAuth: false, errorMessage: "failed to load profile"))
    }

    // Is a handle free within a workspace (by id) or an invite's workspace (by token)?
    func checkHandle(_ handle: String, workspaceId: String? = nil, invite: String? = nil) async throws
        -> (available: Bool, valid: Bool)
    {
        struct Response: Decodable {
            var available: Bool
            var valid: Bool
        }
        var qs = "handle=\(handle.queryEncoded)"
        if let workspaceId { qs += "&workspaceId=\(workspaceId.queryEncoded)" }
        if let invite { qs += "&invite=\(invite.queryEncoded)" }
        let r: Response = try await request("/api/handle-available?\(qs)", .init(errorMessage: "failed to check handle"))
        return (available: r.available, valid: r.valid)
    }

    // Create a new workspace; the caller becomes its admin.
    func createWorkspace(name: String, handle: String, displayName: String) async throws
        -> (workspace: Workspace, participant: Participant)
    {
        struct Body: Encodable {
            var name: String
            var handle: String
            var displayName: String
        }
        struct Response: Decodable {
            var workspace: Workspace
            var participant: Participant
        }
        let r: Response = try await request(
            "/api/workspaces",
            .init(jsonBody: Body(name: name, handle: handle, displayName: displayName),
                  devAuth: false, errorMessage: "failed to create workspace"))
        return (workspace: r.workspace, participant: r.participant)
    }

    // Preview an invite link (workspace name + validity).
    func getInvite(token: String) async throws -> InviteInfo {
        try await request("/api/invites/\(token)", .init(devAuth: false, errorMessage: "failed to load invite"))
    }

    // Join a workspace via an invite link. Idempotent if already a member.
    func acceptInvite(token: String, handle: String, displayName: String) async throws -> Participant {
        struct Body: Encodable {
            var handle: String
            var displayName: String
        }
        return try await request(
            "/api/invites/\(token)/accept",
            .init(jsonBody: Body(handle: handle, displayName: displayName),
                  devAuth: false, errorMessage: "failed to join workspace"))
    }

    // Admin: workspace invite links.
    func listInvites(workspaceId: String) async throws -> [Invite] {
        try await request("/api/workspaces/\(workspaceId)/invites", .init(errorMessage: "failed to load invites"))
    }

    func createInvite(workspaceId: String, expiresInDays: Int? = nil) async throws -> Invite {
        struct Body: Encodable {
            var expiresInDays: Int?
        }
        return try await request(
            "/api/workspaces/\(workspaceId)/invites",
            .init(jsonBody: Body(expiresInDays: expiresInDays), errorMessage: "failed to create invite"))
    }

    func revokeInvite(token: String) async throws {
        try await requestVoid("/api/invites/\(token)/revoke", .init(method: "POST", errorMessage: "failed to revoke invite"))
    }

    // --- Participants ---

    func listParticipants() async throws -> [Participant] {
        try await request("/api/participants", .init(errorMessage: "failed to load participants"))
    }

    // --- Channels / messages ---

    func listChannels() async throws -> [Channel] {
        // The web passes ?participantId= explicitly here; our dev-bypass path appends it for
        // every devAuth request, so the plain path covers both auth modes.
        try await request("/api/channels", .init(errorMessage: "failed to load channels"))
    }

    func getMessages(channelId: String) async throws -> [Message] {
        try await request("/api/channels/\(channelId)/messages", .init(errorMessage: "failed to load messages"))
    }

    struct MarkReadResponse: Decodable {
        var ok: Bool
        var lastReadSeq: Int
    }

    // Advances my last_read_seq to the channel's max message seq (or the supplied seq).
    @discardableResult
    func markChannelRead(channelId: String, seq: Int? = nil) async throws -> MarkReadResponse {
        struct Body: Encodable {
            var seq: Int?
        }
        return try await request(
            "/api/channels/\(channelId)/read",
            .init(method: "POST", jsonBody: Body(seq: seq), errorMessage: "failed to mark read"))
    }

    // --- Threads ---

    func getThread(channelId: String, rootId: String) async throws -> [Message] {
        try await request("/api/channels/\(channelId)/threads/\(rootId)", .init(errorMessage: "failed to load thread"))
    }

    @discardableResult
    func markThreadRead(rootId: String, seq: Int? = nil) async throws -> MarkReadResponse {
        struct Body: Encodable {
            var seq: Int?
        }
        return try await request(
            "/api/threads/\(rootId)/read",
            .init(method: "POST", jsonBody: Body(seq: seq), errorMessage: "failed to mark thread read"))
    }

    func unreadThreads() async throws -> [UnreadThread] {
        try await request("/api/threads/unread", .init(errorMessage: "failed to load threads"))
    }
}
