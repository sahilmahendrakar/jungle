import Foundation

// Hand-ported from shared/src/ws-events.ts — the app WebSocket contract. WS envelopes are
// camelCase on the wire (unlike the snake_case domain rows they carry). A PR touching
// ws-events.ts should touch this file.

// Where an agent's current turn came from (the dispatch the runner consumed).
struct TurnContext: Codable, Hashable, Sendable {
    var channelId: String?
    var threadRootId: String?
    var messageId: String?
}

// From shared/src/slack.ts (carried by slack_link_changed).
struct SlackChannelLink: Codable, Hashable, Sendable {
    var channelId: String
    var slackChannelId: String
    var slackChannelName: String?
    var status: String // "active" | "error"
    var lastError: String?
}

// Server -> client. One case per ServerEvent variant, plus .unknown so a new server event
// type never crashes an old app build.
enum ServerEvent: Sendable {
    case connected(participantId: String)
    case error(String)
    case message(Message)
    case agentStatusChanged(agentId: String, status: AgentStatus)
    case deviceStatusChanged(deviceId: String, online: Bool)
    case membersChanged(channelId: String)
    case channelDeleted(channelId: String)
    case participantUpdated(Participant)
    case participantDeleted(participantId: String)
    case agentTurn(agentId: String, turnId: String, context: TurnContext?)
    case agentEvent(agentId: String, turnId: String, event: JSONValue, context: TurnContext?)
    case agentQueued(agentId: String, context: TurnContext)
    case agentContext(agentId: String, tokens: Int, maxTokens: Int)
    case agentMemoryChanged(agentId: String)
    case toolConfirmationRequest(ToolConfirmation)
    case toolConfirmationResolved(confirmId: String, channelId: String, result: String, by: String?)
    case scheduleChanged(scheduleId: String, action: String)
    case deliverableCreated(Deliverable)
    case slackLinkChanged(channelId: String, link: SlackChannelLink?)
    case unknown(type: String)
}

// The tool_confirmation_request payload (also rebuilt from GET /api/confirmations).
struct ToolConfirmation: Codable, Identifiable, Hashable, Sendable {
    var confirmId: String
    var channelId: String
    var agentId: String
    var agentHandle: String
    var agentName: String
    var tool: String
    var input: JSONValue

    var id: String { confirmId }
}

extension ServerEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, participantId, error, message, agentId, status, deviceId, online, channelId
        case participant, turnId, context, event, tokens, maxTokens, confirmId, result, by
        case scheduleId, action, deliverable, link
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "connected":
            self = .connected(participantId: try c.decode(String.self, forKey: .participantId))
        case "error":
            self = .error(try c.decode(String.self, forKey: .error))
        case "message":
            self = .message(try c.decode(Message.self, forKey: .message))
        case "agent_status_changed":
            self = .agentStatusChanged(
                agentId: try c.decode(String.self, forKey: .agentId),
                status: try c.decode(AgentStatus.self, forKey: .status))
        case "device_status_changed":
            self = .deviceStatusChanged(
                deviceId: try c.decode(String.self, forKey: .deviceId),
                online: try c.decode(Bool.self, forKey: .online))
        case "members_changed":
            self = .membersChanged(channelId: try c.decode(String.self, forKey: .channelId))
        case "channel_deleted":
            self = .channelDeleted(channelId: try c.decode(String.self, forKey: .channelId))
        case "participant_updated":
            self = .participantUpdated(try c.decode(Participant.self, forKey: .participant))
        case "participant_deleted":
            self = .participantDeleted(participantId: try c.decode(String.self, forKey: .participantId))
        case "agent_turn":
            self = .agentTurn(
                agentId: try c.decode(String.self, forKey: .agentId),
                turnId: try c.decode(String.self, forKey: .turnId),
                context: try c.decodeIfPresent(TurnContext.self, forKey: .context))
        case "agent_event":
            self = .agentEvent(
                agentId: try c.decode(String.self, forKey: .agentId),
                turnId: try c.decode(String.self, forKey: .turnId),
                event: try c.decodeIfPresent(JSONValue.self, forKey: .event) ?? .null,
                context: try c.decodeIfPresent(TurnContext.self, forKey: .context))
        case "agent_queued":
            self = .agentQueued(
                agentId: try c.decode(String.self, forKey: .agentId),
                context: try c.decode(TurnContext.self, forKey: .context))
        case "agent_context":
            self = .agentContext(
                agentId: try c.decode(String.self, forKey: .agentId),
                tokens: try c.decode(Int.self, forKey: .tokens),
                maxTokens: try c.decode(Int.self, forKey: .maxTokens))
        case "agent_memory_changed":
            self = .agentMemoryChanged(agentId: try c.decode(String.self, forKey: .agentId))
        case "tool_confirmation_request":
            self = .toolConfirmationRequest(try ToolConfirmation(from: decoder))
        case "tool_confirmation_resolved":
            self = .toolConfirmationResolved(
                confirmId: try c.decode(String.self, forKey: .confirmId),
                channelId: try c.decode(String.self, forKey: .channelId),
                result: try c.decode(String.self, forKey: .result),
                by: try c.decodeIfPresent(String.self, forKey: .by))
        case "schedule_changed":
            self = .scheduleChanged(
                scheduleId: try c.decode(String.self, forKey: .scheduleId),
                action: try c.decode(String.self, forKey: .action))
        case "deliverable_created":
            self = .deliverableCreated(try c.decode(Deliverable.self, forKey: .deliverable))
        case "slack_link_changed":
            self = .slackLinkChanged(
                channelId: try c.decode(String.self, forKey: .channelId),
                link: try c.decodeIfPresent(SlackChannelLink.self, forKey: .link))
        default:
            self = .unknown(type: type)
        }
    }
}

// Client -> server: the single `post` frame (messages, thread replies, steering all go here —
// sending is WS-only, there is no REST send).
struct ClientPostFrame: Encodable, Sendable {
    var type = "post"
    var channelId: String
    var body: String?
    var clientMsgId: String?
    var attachmentIds: [String]?
    var threadRootId: String?
    var alsoToChannel: Bool?
}
