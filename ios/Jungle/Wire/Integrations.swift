import Foundation

// Hand-ported from shared/src/integrations.ts — the integration/connection catalogs. Keep
// 1:1 with the TypeScript source.

struct IntegrationConfigField: Hashable, Sendable {
    var key: String
    var label: String
    var placeholder: String?
}

// A per-USER account link that integrations are built on (Settings → Connections).
struct ConnectionType: Identifiable, Hashable, Sendable {
    var key: String
    var name: String
    var description: String
    var kind: Kind

    var id: String { key }

    enum Kind: String, Sendable {
        case github, google, integration
    }
}

struct IntegrationType: Identifiable, Hashable, Sendable {
    var key: String
    var name: String
    var description: String
    var connectionKey: String
    var configFields: [IntegrationConfigField]
    var comingSoon = false
    var oauthConnection = false // integrations.ts `connection: "oauth"`
    var readOnly = false

    var id: String { key }
}

let integrationTypes: [IntegrationType] = [
    .init(
        key: "github",
        name: "GitHub",
        description: "Pick a repo. Agent can clone, read code, open PRs & commit via git + gh CLI.",
        connectionKey: "github",
        configFields: [.init(key: "repo", label: "Repository", placeholder: "owner/name")]),
    .init(
        key: "gmail",
        name: "Gmail",
        description: "Read, search & send email from your connected Gmail. Sending can require your approval.",
        connectionKey: "google",
        configFields: []),
    .init(
        key: "linear",
        name: "Linear",
        description: "Read, create & update Linear issues, projects & comments via Linear's MCP server.",
        connectionKey: "linear",
        configFields: [],
        oauthConnection: true),
    .init(
        key: "google-drive",
        name: "Google Drive",
        description: "Search, read, create & update files in a connected Google Drive.",
        connectionKey: "google-drive",
        configFields: [],
        oauthConnection: true),
    .init(
        key: "notion",
        name: "Notion",
        description: "Search, read & write pages and databases in a connected Notion workspace.",
        connectionKey: "notion",
        configFields: [],
        oauthConnection: true),
    .init(
        key: "granola",
        name: "Granola",
        description: "Search and read your Granola meeting notes and transcripts.",
        connectionKey: "granola",
        configFields: [],
        oauthConnection: true,
        readOnly: true),
]

let connectionTypes: [ConnectionType] = [
    .init(
        key: "github",
        name: "GitHub",
        description: "Repo access for agents — clone, read code, commit & open PRs via the Jungle GitHub App.",
        kind: .github),
    .init(
        key: "google",
        name: "Google",
        description: "Backs the Gmail integration — agents read, search & send email from this account.",
        kind: .google),
] + integrationTypes.filter { $0.oauthConnection && !$0.comingSoon }.map {
    ConnectionType(key: $0.key, name: $0.name, description: $0.description, kind: .integration)
}

func integrationType(_ key: String) -> IntegrationType? {
    integrationTypes.first { $0.key == key }
}

// One integration attached to a specific agent (GET /api/agents/:id/integrations).
struct AgentIntegration: Codable, Identifiable, Hashable, Sendable {
    var agentId: String
    var integrationKey: String
    var config: [String: JSONValue]

    var id: String { integrationKey }

    enum CodingKeys: String, CodingKey {
        case config
        case agentId = "agent_id"
        case integrationKey = "integration_key"
    }
}
