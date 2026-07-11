import SwiftUI
import SafariServices

// Settings — the port of Settings.tsx: account, Connections (GitHub/Google/Slack/Linear/
// Notion/Granola/Drive OAuth), workspace invites (admins), and sign out.
//
// OAuth connects open the provider's authorize URL in an in-app Safari sheet and poll the
// status endpoint until `connected` flips (the web's popup callback page can't signal a
// native app), then auto-dismiss.
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var sessionStore

    @State private var github: GithubStatus?
    @State private var google: GoogleStatus?
    @State private var integrationStatuses: [String: IntegrationConnectionStatus] = [:]
    @State private var slack: SlackStatus?
    @State private var oauthURL: IdentifiedURL?
    @State private var pollTask: Task<Void, Never>?

    struct IdentifiedURL: Identifiable {
        let id = UUID()
        var url: URL
    }

    var body: some View {
        List {
            accountSection
            connectionsSection
            slackSection
            if isAdmin {
                InviteSection()
            }
            Section {
                Button("Sign out", role: .destructive) {
                    store.shutdown()
                    sessionStore.signOut()
                }
            }
        }
        .navigationTitle("Settings")
        .task { await refresh() }
        .refreshable { await refresh() }
        .sheet(item: $oauthURL, onDismiss: { pollTask?.cancel() }) { wrapped in
            SafariView(url: wrapped.url)
                .ignoresSafeArea()
        }
    }

    private var isAdmin: Bool {
        store.people.first { $0.id == store.participantId }?.role == "admin"
    }

    private var accountSection: some View {
        Section("Account") {
            if let me = sessionStore.me {
                LabeledContent("Signed in as", value: me.profile.email ?? me.profile.name ?? "—")
            }
            if let self_ = store.people.first(where: { $0.id == store.participantId }) {
                LabeledContent("Handle", value: "@\(self_.handle)")
            }
            #if DEBUG
            LabeledContent("Backend", value: sessionStore.environment.label)
            #endif
        }
    }

    private var connectionsSection: some View {
        Section("Connections") {
            ConnectionRow(
                name: "GitHub",
                detail: github?.login.map { "@\($0)" },
                connected: github?.connected == true,
                connect: { await startOAuth { try await store.api.githubConnectUrl() } },
                disconnect: { try? await store.api.disconnectGithub(); await refresh() })
            ConnectionRow(
                name: "Google",
                detail: google?.email,
                connected: google?.connected == true,
                connect: { await startOAuth { try await store.api.googleConnectUrl() } },
                disconnect: { try? await store.api.disconnectGoogle(); await refresh() })
            ForEach(connectionTypes.filter { $0.kind == .integration }) { type in
                let status = integrationStatuses[type.key]
                ConnectionRow(
                    name: type.name,
                    detail: status?.externalAccount,
                    connected: status?.connected == true,
                    connect: { await startOAuth { try await store.api.integrationConnectUrl(key: type.key) } },
                    disconnect: { try? await store.api.disconnectIntegration(key: type.key); await refresh() })
            }
        }
    }

    private var slackSection: some View {
        Section("Slack") {
            if let slack, slack.installed {
                LabeledContent("Workspace", value: slack.teamName ?? "connected")
                if slack.status == "revoked" {
                    Text("Install was revoked — reconnect from Slack.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Button("Disconnect Slack", role: .destructive) {
                    Task {
                        try? await store.api.disconnectSlack()
                        await refresh()
                    }
                }
            } else {
                Button("Connect Slack") {
                    Task { await startOAuth { try await store.api.slackInstallUrl() } }
                }
            }
        }
    }

    private func refresh() async {
        async let g = store.api.getGithubStatus()
        async let go = store.api.getGoogleStatus()
        async let i = store.api.getIntegrationStatuses()
        async let s = store.api.getSlackStatus()
        github = try? await g
        google = try? await go
        integrationStatuses = (try? await i) ?? [:]
        slack = try? await s
    }

    // Open the authorize URL and poll status every 2 s; when anything flips, refresh and
    // dismiss the sheet.
    private func startOAuth(_ getUrl: @escaping () async throws -> URL) async {
        do {
            let url = try await getUrl()
            let baseline = snapshot
            oauthURL = IdentifiedURL(url: url)
            pollTask?.cancel()
            pollTask = Task {
                for _ in 0..<90 { // up to 3 minutes
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { return }
                    await refresh()
                    if snapshot != baseline {
                        oauthURL = nil
                        return
                    }
                }
            }
        } catch {
            // surfaced by the row staying disconnected
        }
    }

    private var snapshot: String {
        let integrations = integrationStatuses.map { "\($0.key):\($0.value.connected)" }.sorted().joined()
        return "\(github?.connected == true)|\(google?.connected == true)|\(slack?.installed == true)|\(integrations)"
    }
}

private struct ConnectionRow: View {
    let name: String
    let detail: String?
    let connected: Bool
    let connect: () async -> Void
    let disconnect: () async -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if connected {
                Menu {
                    Button("Disconnect", role: .destructive) {
                        Task { await disconnect() }
                    }
                } label: {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            } else {
                Button("Connect") {
                    Task { await connect() }
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.bordered)
            }
        }
    }
}

// Admin: workspace invite links — the invites part of Settings/InviteDialog.
private struct InviteSection: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var sessionStore

    @State private var invites: [Invite] = []
    @State private var createdLink: String?

    var body: some View {
        Section("Invites") {
            if let createdLink {
                ShareLink(item: createdLink) {
                    Label("Share invite link", systemImage: "square.and.arrow.up")
                }
            }
            Button("Create invite link") {
                Task {
                    guard let workspaceId = sessionStore.session?.workspaceId else { return }
                    if let invite = try? await store.api.createInvite(workspaceId: workspaceId) {
                        createdLink = "https://jungleagents.com/join/\(invite.token)"
                        await load()
                    }
                }
            }
            ForEach(invites, id: \.token) { invite in
                HStack {
                    Text(String(invite.token.prefix(12)) + "…")
                        .font(.caption.monospaced())
                    Spacer()
                    Button("Revoke", role: .destructive) {
                        Task {
                            try? await store.api.revokeInvite(token: invite.token)
                            await load()
                        }
                    }
                    .font(.caption)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let workspaceId = sessionStore.session?.workspaceId else { return }
        invites = (try? await store.api.listInvites(workspaceId: workspaceId)) ?? []
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
