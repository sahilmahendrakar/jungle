import Foundation

// Endpoints backing the M4 pages: devices/environments, agent integrations, per-user
// connections (GitHub/Google/integration OAuth), Slack, schedules, channel admin.
// Mirrors frontend/src/api.ts.

// From shared/src/slack.ts.
struct SlackStatus: Codable, Hashable, Sendable {
    var installed: Bool
    var teamName: String?
    var status: String?
}

struct SlackChannelInfo: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var isPrivate: Bool
    var isMember: Bool
}

struct GithubStatus: Codable, Sendable {
    var connected: Bool
    var login: String?
    var installUrl: String?
    var installationCount: Int?
    var repoCount: Int?
}

struct GoogleStatus: Codable, Sendable {
    var connected: Bool
    var email: String?
}

struct IntegrationConnectionStatus: Codable, Sendable {
    var connected: Bool
    var externalAccount: String?
}

struct GithubRepo: Codable, Hashable, Sendable {
    var fullName: String
    var isPrivate: Bool
    var pushedAt: String?

    enum CodingKeys: String, CodingKey {
        case fullName = "full_name"
        case isPrivate = "private"
        case pushedAt = "pushed_at"
    }
}

extension APIClient {
    // --- Self-hosted devices (Environments) ---

    func listDevices() async throws -> [RunnerHost] {
        try await request("/api/devices", .init(errorMessage: "failed to load devices"))
    }

    func updateDevice(
        id: String, name: String? = nil, assignPolicy: String? = nil,
        sharedWorkspaceIds: [String]? = nil, sandboxed: Bool? = nil
    ) async throws -> RunnerHost {
        struct Body: Encodable {
            var name: String?
            var assignPolicy: String?
            var sharedWorkspaceIds: [String]?
            var sandboxed: Bool?
        }
        return try await request(
            "/api/devices/\(id)",
            .init(method: "PATCH",
                  jsonBody: Body(name: name, assignPolicy: assignPolicy,
                                 sharedWorkspaceIds: sharedWorkspaceIds, sandboxed: sandboxed),
                  errorMessage: "failed to update device"))
    }

    func removeDevice(id: String) async throws {
        try await requestVoid("/api/devices/\(id)", .init(method: "DELETE", errorMessage: "failed to remove device"))
    }

    // Approve a device-code shown by `jungle-agents connect` (the /link page).
    func approveDeviceCode(_ userCode: String) async throws {
        struct Body: Encodable {
            var userCode: String
        }
        try await requestVoid(
            "/api/devices/auth/approve",
            .init(jsonBody: Body(userCode: userCode), errorMessage: "failed to approve device"))
    }

    func checkDeviceCode(_ userCode: String) async throws -> Bool {
        struct Response: Decodable {
            var valid: Bool
        }
        let r: Response = try await request(
            "/api/devices/auth/\(userCode.queryEncoded)", .init(errorMessage: "failed to check code"))
        return r.valid
    }

    // --- Agent integrations ---

    func listAgentIntegrations(agentId: String) async throws -> [AgentIntegration] {
        try await request("/api/agents/\(agentId)/integrations", .init(errorMessage: "failed to load integrations"))
    }

    func setAgentIntegration(agentId: String, key: String, config: [String: JSONValue]) async throws -> AgentIntegration {
        struct Body: Encodable {
            var config: [String: JSONValue]
        }
        return try await request(
            "/api/agents/\(agentId)/integrations/\(key)",
            .init(method: "PUT", jsonBody: Body(config: config), errorMessage: "failed to add integration"))
    }

    func removeAgentIntegration(agentId: String, key: String) async throws {
        try await requestVoid(
            "/api/agents/\(agentId)/integrations/\(key)",
            .init(method: "DELETE", errorMessage: "failed to remove integration"))
    }

    // --- Per-user connections (Settings → Connections) ---

    func githubConnectUrl() async throws -> URL {
        try await connectUrl("/api/github/connect-url")
    }

    func disconnectGithub() async throws {
        try await requestVoid("/api/github/connection", .init(method: "DELETE", errorMessage: "failed to disconnect GitHub"))
    }

    func getGithubStatus() async throws -> GithubStatus {
        try await request("/api/github/status", .init(errorMessage: "failed to load GitHub status"))
    }

    // A 409 (GitHub not connected) returns connected:false rather than throwing.
    func listGithubRepos() async throws -> (connected: Bool, repos: [GithubRepo]) {
        struct Response: Decodable {
            var connected: Bool
            var repos: [GithubRepo]?
        }
        do {
            let r: Response = try await request("/api/github/repos", .init(errorMessage: "failed to list repos"))
            return (connected: r.connected, repos: r.repos ?? [])
        } catch let error as APIError where error.status == 409 {
            return (connected: false, repos: [])
        }
    }

    func googleConnectUrl() async throws -> URL {
        try await connectUrl("/api/google/connect-url")
    }

    func disconnectGoogle() async throws {
        try await requestVoid("/api/google/connection", .init(method: "DELETE", errorMessage: "failed to disconnect Google"))
    }

    func getGoogleStatus() async throws -> GoogleStatus {
        try await request("/api/google/status", .init(errorMessage: "failed to load Google status"))
    }

    func integrationConnectUrl(key: String) async throws -> URL {
        try await connectUrl("/api/integrations/\(key)/connect-url")
    }

    func getIntegrationStatuses() async throws -> [String: IntegrationConnectionStatus] {
        try await request("/api/integrations/status", .init(errorMessage: "failed to load integration connections"))
    }

    func disconnectIntegration(key: String) async throws {
        try await requestVoid(
            "/api/integrations/\(key)/connection", .init(method: "DELETE", errorMessage: "failed to disconnect"))
    }

    // Begin an OAuth connect: the provider authorize URL. The web passes popup:true for its
    // window.open flow; the iOS client opens the URL in the system browser and polls status
    // until connected (no in-app callback needed).
    private func connectUrl(_ path: String) async throws -> URL {
        struct Body: Encodable {
            var popup = false
        }
        struct Response: Decodable {
            var url: String
        }
        let r: Response = try await request(path, .init(jsonBody: Body(), errorMessage: "failed to start connect"))
        guard let url = URL(string: r.url) else { throw APIError(message: "bad connect url") }
        return url
    }

    // --- Slack ---

    func getSlackStatus() async throws -> SlackStatus {
        try await request("/api/slack/status", .init(errorMessage: "failed to load Slack status"))
    }

    func slackInstallUrl() async throws -> URL {
        try await connectUrl("/api/slack/install-url")
    }

    func disconnectSlack() async throws {
        try await requestVoid("/api/slack/install", .init(method: "DELETE", errorMessage: "failed to disconnect Slack"))
    }

    func listSlackChannels() async throws -> [SlackChannelInfo] {
        try await request("/api/slack/channels", .init(errorMessage: "failed to list Slack channels"))
    }

    func getChannelSlackLink(channelId: String) async throws -> SlackChannelLink? {
        struct Response: Decodable {
            var link: SlackChannelLink?
        }
        let r: Response = try await request(
            "/api/channels/\(channelId)/slack-link", .init(errorMessage: "failed to load Slack link"))
        return r.link
    }

    func linkChannelToSlack(channelId: String, slackChannelId: String) async throws -> SlackChannelLink? {
        struct Body: Encodable {
            var slackChannelId: String
        }
        struct Response: Decodable {
            var link: SlackChannelLink?
        }
        let r: Response = try await request(
            "/api/channels/\(channelId)/slack-link",
            .init(method: "PUT", jsonBody: Body(slackChannelId: slackChannelId),
                  errorMessage: "failed to link channel to Slack"))
        return r.link
    }

    func unlinkChannelFromSlack(channelId: String) async throws {
        try await requestVoid(
            "/api/channels/\(channelId)/slack-link",
            .init(method: "DELETE", errorMessage: "failed to unlink channel from Slack"))
    }

    // --- Schedules ---

    func listSchedules() async throws -> [Schedule] {
        struct Response: Decodable {
            var schedules: [Schedule]
        }
        let r: Response = try await request("/api/schedules", .init(errorMessage: "failed to load schedules"))
        return r.schedules
    }

    func createSchedule(
        agentId: String, channelId: String, prompt: String,
        cron: String? = nil, timezone: String? = nil, runAt: String? = nil
    ) async throws -> Schedule {
        struct Body: Encodable {
            var agentId: String
            var channelId: String
            var prompt: String
            var cron: String?
            var timezone: String?
            var runAt: String?
        }
        return try await request(
            "/api/schedules",
            .init(jsonBody: Body(agentId: agentId, channelId: channelId, prompt: prompt,
                                 cron: cron, timezone: timezone, runAt: runAt),
                  errorMessage: "failed to create schedule"))
    }

    func updateSchedule(id: String, prompt: String? = nil, paused: Bool? = nil) async throws -> Schedule {
        struct Body: Encodable {
            var prompt: String?
            var paused: Bool?
        }
        return try await request(
            "/api/schedules/\(id)",
            .init(method: "PATCH", jsonBody: Body(prompt: prompt, paused: paused),
                  errorMessage: "failed to update schedule"))
    }

    func deleteSchedule(id: String) async throws {
        try await requestVoid("/api/schedules/\(id)", .init(method: "DELETE", errorMessage: "failed to delete schedule"))
    }

    // --- Channel admin ---

    func createChannel(name: String, kind: String, memberHandles: [String]) async throws -> Channel {
        struct Body: Encodable {
            var name: String
            var kind: String
            var memberHandles: [String]
        }
        return try await request(
            "/api/channels",
            .init(jsonBody: Body(name: name, kind: kind, memberHandles: memberHandles),
                  errorMessage: "failed to create channel"))
    }

    func addChannelMember(channelId: String, handle: String) async throws -> Participant {
        struct Body: Encodable {
            var handle: String
        }
        return try await request(
            "/api/channels/\(channelId)/members",
            .init(jsonBody: Body(handle: handle), errorMessage: "failed to add member"))
    }

    func removeChannelMember(channelId: String, participantId: String) async throws {
        try await requestVoid(
            "/api/channels/\(channelId)/members/\(participantId)",
            .init(method: "DELETE", errorMessage: "failed to remove member"))
    }

    func deleteChannel(channelId: String) async throws {
        try await requestVoid("/api/channels/\(channelId)", .init(method: "DELETE", errorMessage: "failed to delete channel"))
    }

    // Create an agent (AddAgentDialog): blank chat agent unless integrations are attached.
    func createAgent(
        handle: String, displayName: String,
        integrations: [(key: String, config: [String: JSONValue])] = [],
        model: String? = nil, mode: String? = nil,
        runnerProvider: String? = nil, hostId: String? = nil
    ) async throws -> Participant {
        struct IntegrationBody: Encodable {
            var key: String
            var config: [String: JSONValue]
        }
        struct Body: Encodable {
            var handle: String
            var displayName: String
            var integrations: [IntegrationBody]?
            var model: String?
            var mode: String?
            var runnerProvider: String?
            var hostId: String?
        }
        return try await request(
            "/api/agents",
            .init(jsonBody: Body(
                handle: handle, displayName: displayName,
                integrations: integrations.isEmpty ? nil : integrations.map { .init(key: $0.key, config: $0.config) },
                model: model, mode: mode, runnerProvider: runnerProvider, hostId: hostId),
                errorMessage: "create failed"))
    }
}
