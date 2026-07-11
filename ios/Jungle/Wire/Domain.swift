import Foundation

// Hand-ported from shared/src/domain.ts — the wire shapes that cross the HTTP/WS boundary.
// Keep 1:1 with the TypeScript source; a PR touching domain.ts should touch this file.
// Domain rows are snake_case on the wire (explicit CodingKeys); timestamps stay ISO strings
// (parse at display time, like the web).

enum Kind: String, Codable, Sendable {
    case human
    case agent
}

// Decoded tolerantly: an unrecognized status from a newer server maps to .offline-ish unknown
// rather than failing the whole participant decode.
enum AgentStatus: String, Codable, Sendable {
    case working
    case idle
    case sleeping
    case waking
    case offline
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentStatus(rawValue: raw) ?? .unknown
    }
}

enum RunnerProvider: String, Codable, Sendable {
    case docker
    case fly
    case selfHosted = "self_hosted"
}

// ParticipantBase + Participant from domain.ts, flattened (Swift has no interface extension;
// `status`/`memoryChangedAt` are simply optional here).
struct Participant: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var kind: Kind
    var workspaceId: String
    var role: String
    var handle: String
    var displayName: String
    var repo: String?
    var firebaseUid: String?
    var email: String?
    var avatarUrl: String?
    var model: String?
    var mode: String
    var effort: String
    var runtime: String
    var contextTokens: Int?
    var contextMaxTokens: Int?
    var contextUpdatedAt: String?
    var runnerProvider: String
    var runnerMeta: [String: JSONValue]?
    var persona: String?
    var status: AgentStatus?
    // Client-side only on the web (stamped when agent_memory_changed lands); optional here too.
    var memoryChangedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, role, handle, repo, email, model, mode, effort, runtime, persona, status
        case workspaceId = "workspace_id"
        case displayName = "display_name"
        case firebaseUid = "firebase_uid"
        case avatarUrl = "avatar_url"
        case contextTokens = "context_tokens"
        case contextMaxTokens = "context_max_tokens"
        case contextUpdatedAt = "context_updated_at"
        case runnerProvider = "runner_provider"
        case runnerMeta = "runner_meta"
        case memoryChangedAt = "memory_changed_at"
    }
}

// --- Self-hosted devices ---

enum DeviceAssignPolicy: String, Codable, Sendable {
    case ownerOnly = "owner_only"
    case workspaceMembers = "workspace_members"
}

struct RunnerHost: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var hostname: String?
    var platform: String?
    var arch: String?
    var runnerVersion: String?
    var assignPolicy: DeviceAssignPolicy
    var sharedWorkspaceIds: [String]
    var sandboxed: Bool
    var createdAt: String
    var lastSeenAt: String?
    var online: Bool
    var runningAgents: Int

    enum CodingKeys: String, CodingKey {
        case id, name, hostname, platform, arch, sandboxed, online
        case runnerVersion = "runner_version"
        case assignPolicy = "assign_policy"
        case sharedWorkspaceIds = "shared_workspace_ids"
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
        case runningAgents = "running_agents"
    }
}

// The minimum runner version that honors the `sandboxed` flag (see domain.ts).
let unsandboxedMinRunnerVersion = "0.1.1"

// Compare two dotted numeric version strings; missing/non-numeric parts count as 0.
func compareVersions(_ a: String, _ b: String) -> Int {
    let pa = a.split(separator: ".").map { Int($0) ?? 0 }
    let pb = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<max(pa.count, pb.count) {
        let d = (i < pa.count ? pa[i] : 0) - (i < pb.count ? pb[i] : 0)
        if d != 0 { return d }
    }
    return 0
}

func supportsUnsandboxed(_ version: String?) -> Bool {
    guard let version, !version.isEmpty else { return false }
    return compareVersions(version, unsandboxedMinRunnerVersion) >= 0
}

// --- Workspaces ---

struct Workspace: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
}

struct GoogleProfile: Codable, Hashable, Sendable {
    var uid: String
    var email: String?
    var name: String?
    var picture: String?
}

struct Membership: Codable, Hashable, Sendable {
    var workspace: Workspace
    var participant: Participant
    var github: GithubStatus

    struct GithubStatus: Codable, Hashable, Sendable {
        var connected: Bool
        var login: String?
    }
}

// GET /api/me
struct Me: Codable, Hashable, Sendable {
    var profile: GoogleProfile
    var memberships: [Membership]
    var suggestedHandle: String
}

// GET /api/invites/:token
struct InviteInfo: Codable, Hashable, Sendable {
    var valid: Bool
    var workspaceName: String?
    var alreadyMember: Bool?
}

// An admin-visible invite link row.
struct Invite: Codable, Hashable, Sendable {
    var token: String
    var expiresAt: String?
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }
}

// --- Attachments / messages ---

// AttachmentMeta + Attachment flattened: `url` (origin-relative signed download path) is present
// on client-facing shapes (WireMessage attachments, upload response) and absent otherwise.
struct Attachment: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var filename: String
    var mime: String
    var sizeBytes: Int
    var width: Int?
    var height: Int?
    var url: String?

    enum CodingKeys: String, CodingKey {
        case id, filename, mime, width, height, url
        case sizeBytes = "size_bytes"
    }
}

// WireMessage from domain.ts (a message as sent to clients; attachments carry signed urls).
struct Message: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var channelId: String
    var seq: String // bigint serialized as string
    var senderId: String
    var senderHandle: String
    var body: String
    var createdAt: String
    var cascadeBudget: Int?
    var turnId: String?
    var threadRootId: String?
    var alsoToChannel: Bool
    var replyCount: Int
    var lastReplyAt: String?
    var mentions: [Mention]
    var attachments: [Attachment]

    struct Mention: Codable, Hashable, Sendable {
        var id: String
        var handle: String
    }

    enum CodingKeys: String, CodingKey {
        case id, seq, body, mentions, attachments
        case channelId = "channel_id"
        case senderId = "sender_id"
        case senderHandle = "sender_handle"
        case createdAt = "created_at"
        case cascadeBudget = "cascade_budget"
        case turnId = "turn_id"
        case threadRootId = "thread_root_id"
        case alsoToChannel = "also_to_channel"
        case replyCount = "reply_count"
        case lastReplyAt = "last_reply_at"
    }
}

// ChannelListItem from domain.ts. Several fields are optional because POST /api/channels
// returns a bare channel row (see frontend Channel type, which marks them optional).
struct Channel: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var kind: String
    var dmWith: String?
    var unreadCount: Int?
    var hasMention: Bool?
    var memberAgentIds: [String]?

    enum CodingKeys: String, CodingKey {
        case id, name, kind
        case dmWith = "dm_with"
        case unreadCount = "unread_count"
        case hasMention = "has_mention"
        case memberAgentIds = "member_agent_ids"
    }

    var isDM: Bool { kind == "dm" }
}

// GET /api/threads/unread
struct UnreadThread: Codable, Hashable, Sendable {
    var rootId: String
    var channelId: String
    var channelName: String
    var rootSenderHandle: String
    var rootBody: String
    var replyCount: Int
    var lastReplyAt: String?
    var unreadCount: Int

    enum CodingKeys: String, CodingKey {
        case rootId = "root_id"
        case channelId = "channel_id"
        case channelName = "channel_name"
        case rootSenderHandle = "root_sender_handle"
        case rootBody = "root_body"
        case replyCount = "reply_count"
        case lastReplyAt = "last_reply_at"
        case unreadCount = "unread_count"
    }
}

// One persisted Claude Agent SDK stream message. `event` is raw SDK JSON — render defensively.
// `id` is a bigint that the REST API serializes as a STRING while live frames use synthetic
// numbers (Date.now()+random on web) — decode both.
struct AgentEvent: Codable, Identifiable, Hashable, Sendable {
    var id: Double
    var turnId: String
    var event: JSONValue
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, event
        case turnId = "turn_id"
        case createdAt = "created_at"
    }

    init(id: Double, turnId: String, event: JSONValue, createdAt: String) {
        self.id = id
        self.turnId = turnId
        self.event = event
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let n = try? c.decode(Double.self, forKey: .id) {
            id = n
        } else {
            let s = try c.decode(String.self, forKey: .id)
            id = Double(s) ?? 0
        }
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId) ?? "—"
        event = try c.decodeIfPresent(JSONValue.self, forKey: .event) ?? .null
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

// --- Deliverables ---

enum DeliverableKind: String, Codable, Sendable {
    case githubPr = "github_pr"
    case githubIssue = "github_issue"
    case github
    case notion
    case googleDoc = "google_doc"
    case googleDrive = "google_drive"
    case linear
    case granola
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DeliverableKind(rawValue: raw) ?? .unknown
    }
}

struct Deliverable: Codable, Identifiable, Hashable, Sendable {
    var id: Int
    var agentId: String
    var agentHandle: String
    var channelId: String
    var channelName: String
    var channelKind: String
    var messageId: String
    var kind: DeliverableKind
    var title: String?
    var url: String
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, kind, title, url
        case agentId = "agent_id"
        case agentHandle = "agent_handle"
        case channelId = "channel_id"
        case channelName = "channel_name"
        case channelKind = "channel_kind"
        case messageId = "message_id"
        case createdAt = "created_at"
    }
}

// GET /api/search
struct SearchResult: Codable, Hashable, Sendable {
    var messageId: String
    var channelId: String
    var channelName: String
    var channelKind: String
    var dmWith: String?
    var threadRootId: String?
    var senderHandle: String
    var body: String
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case body
        case messageId = "message_id"
        case channelId = "channel_id"
        case channelName = "channel_name"
        case channelKind = "channel_kind"
        case dmWith = "dm_with"
        case threadRootId = "thread_root_id"
        case senderHandle = "sender_handle"
        case createdAt = "created_at"
    }
}
