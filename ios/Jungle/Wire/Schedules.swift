import Foundation

// Hand-ported from shared/src/schedules.ts. Standing instructions that fire agent turns on a
// cadence — recurring (cron + timezone) or one-shot (run_at).
struct Schedule: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var workspaceId: String
    var agentId: String
    var channelId: String
    var createdBy: String?
    var prompt: String
    var cron: String?
    var timezone: String?
    var runAt: String?
    var nextRunAt: String?
    var pausedAt: String?
    var lastRunAt: String?
    var lastStatus: String? // "pending" | "success" | "failure"
    var lastError: String?
    var failureCount: Int
    var createdAt: String
    var agentHandle: String?
    var agentName: String?
    var channelName: String?

    enum CodingKeys: String, CodingKey {
        case id, prompt, cron, timezone
        case workspaceId = "workspace_id"
        case agentId = "agent_id"
        case channelId = "channel_id"
        case createdBy = "created_by"
        case runAt = "run_at"
        case nextRunAt = "next_run_at"
        case pausedAt = "paused_at"
        case lastRunAt = "last_run_at"
        case lastStatus = "last_status"
        case lastError = "last_error"
        case failureCount = "failure_count"
        case createdAt = "created_at"
        case agentHandle = "agent_handle"
        case agentName = "agent_name"
        case channelName = "channel_name"
    }
}
