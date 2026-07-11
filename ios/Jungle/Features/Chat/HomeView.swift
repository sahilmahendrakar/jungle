import SwiftUI

// The signed-in shell: creates the AppStore for the session, starts the socket, and shows
// the sidebar-equivalent Home list (channels / DMs / threads) — the iPhone counterpart of
// the web's Sidebar.tsx in its mobile drawer mode.
struct SignedInShell: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.scenePhase) private var scenePhase

    @State private var store: AppStore?
    @State private var selectedTab = 0

    var body: some View {
        Group {
            if let store {
                @Bindable var store = store
                TabView(selection: $selectedTab) {
                    HomeView()
                        .tabItem { Label("Home", systemImage: "bubble.left.and.bubble.right") }
                        .badge(totalUnread(store))
                        .tag(0)
                    AgentsHomeView()
                        .tabItem { Label("Agents", systemImage: "sparkles") }
                        .tag(1)
                    ApprovalsView()
                        .tabItem { Label("Approvals", systemImage: "checkmark.seal") }
                        .badge(store.confirms.count)
                        .tag(2)
                    MoreView()
                        .tabItem { Label("More", systemImage: "ellipsis") }
                        .tag(3)
                }
                .onReceive(PushManager.shared.$deepLink) { link in
                    guard let link else { return }
                    PushManager.shared.deepLink = nil
                    switch link {
                    case .approvals:
                        selectedTab = 2
                    case .channel(let id, let threadRootId):
                        selectedTab = 0
                        store.pendingChannelLink = .init(channelId: id, threadRootId: threadRootId)
                    }
                }
                .sheet(item: Binding(
                    get: { store.profileParticipantId.map { ProfileRef(id: $0) } },
                    set: { store.profileParticipantId = $0?.id }
                )) { ref in
                    AgentProfileView(participantId: ref.id)
                }
                .sheet(item: Binding(
                    get: {
                        store.activitySheetAgentId
                            .flatMap { id in store.people.first { $0.id == id } }
                    },
                    set: { (agent: Participant?) in store.activitySheetAgentId = agent?.id }
                )) { agent in
                    AgentActivityView(agent: agent)
                }
                .environment(store)
            } else {
                ProgressView()
            }
        }
        .task {
            guard store == nil, let session = sessionStore.session else { return }
            let appStore = AppStore(api: sessionStore.api, session: session)
            store = appStore
            appStore.startSocket(
                environment: sessionStore.environment,
                tokenProvider: sessionStore.tokenProvider)
            // Push only exists in Firebase mode (tokens are account-scoped by firebase uid).
            if session.mode == .firebase {
                PushManager.shared.api = sessionStore.api
                await PushManager.shared.enablePush()
            }
            await appStore.loadInitial()
            #if DEBUG
            // Test scaffolding: SIMCTL_CHILD_JUNGLE_AUTO_ACTIVITY=<agentId> opens the Activity
            // sheet at launch (simulator automation can't tap).
            if let agentId = ProcessInfo.processInfo.environment["JUNGLE_AUTO_ACTIVITY"], !agentId.isEmpty {
                appStore.activitySheetAgentId = agentId
            }
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            // Background: let the socket die. Active: reconnect immediately; the connect
            // lifecycle runs the full backfill (history merge, confirms, channels, threads).
            store?.setActive(phase == .active)
        }
        .onDisappear {
            store?.shutdown()
        }
    }
}

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var sessionStore

    @State private var path = NavigationPath()
    @State private var searchQuery = ""
    @State private var showNewChannel = false

    var body: some View {
        NavigationStack(path: $path) {
            // The web's signature always-dark forest sidebar: flat rows on deep green.
            List {
                // Sidebar header: the workspace name (the web's workspace switcher slot).
                Text(workspaceName)
                    .font(.title.bold())
                    .foregroundStyle(JungleTheme.sidebarAccentForeground)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .padding(.top, 2)

                if let notice = store.notice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(JungleTheme.sidebarForeground.opacity(0.7))
                        .listRowBackground(JungleTheme.sidebarAccent)
                }

                if !store.unreadThreads.isEmpty {
                    Section {
                        ForEach(store.unreadThreads, id: \.rootId) { thread in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("#\(thread.channelName)")
                                    .font(.caption)
                                    .foregroundStyle(JungleTheme.sidebarForeground.opacity(0.55))
                                Text(thread.rootBody)
                                    .lineLimit(1)
                                    .foregroundStyle(JungleTheme.sidebarForeground)
                            }
                            .badge(thread.unreadCount)
                            .listRowBackground(Color.clear)
                        }
                    } header: {
                        SidebarSectionHeader("Threads")
                    }
                }

                Section {
                    ForEach(store.channels.filter { !$0.isDM }) { channel in
                        NavigationLink(value: channel.id) {
                            ChannelRow(channel: channel)
                        }
                        .listRowBackground(Color.clear)
                    }
                } header: {
                    SidebarSectionHeader("Channels")
                }

                Section {
                    ForEach(store.channels.filter(\.isDM)) { channel in
                        NavigationLink(value: channel.id) {
                            ChannelRow(channel: channel)
                        }
                        .listRowBackground(Color.clear)
                    }
                    // People without an open DM yet (tap to start one) — the sidebar People list.
                    ForEach(peopleWithoutDM) { p in
                        Button {
                            Task {
                                if let dm = try? await store.api.openDM(otherId: p.id, participantId: store.participantId) {
                                    await store.reloadChannels()
                                    path.append(dm.id)
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "plus.bubble")
                                    .font(.footnote)
                                Text(p.handle)
                            }
                            .foregroundStyle(JungleTheme.sidebarForeground.opacity(0.55))
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                    }
                } header: {
                    SidebarSectionHeader("Direct messages")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(JungleTheme.sidebar)
            .listRowSeparatorTint(JungleTheme.sidebarBorder)
            .toolbarBackground(JungleTheme.sidebar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchQuery, prompt: "Search messages")
            .overlay {
                if !searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                    SearchResultsView(query: searchQuery) { result in
                        searchQuery = ""
                        path.append(result.channelId)
                    }
                }
            }
            .sheet(isPresented: $showNewChannel) {
                NewChannelView()
            }
            .onAppear { consumePendingLink() }
            .onChange(of: store.pendingChannelLink) { _, _ in consumePendingLink() }
            .navigationDestination(for: String.self) { channelId in
                ChatView(channelId: channelId)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewChannel = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // Workspace switcher (Firebase mode with more than one membership).
                        if let me = sessionStore.me, me.memberships.count > 1 {
                            Section("Workspaces") {
                                ForEach(me.memberships, id: \.workspace.id) { membership in
                                    Button {
                                        store.shutdown()
                                        sessionStore.activate(membership: membership)
                                    } label: {
                                        if membership.workspace.id == sessionStore.session?.workspaceId {
                                            Label(membership.workspace.name, systemImage: "checkmark")
                                        } else {
                                            Text(membership.workspace.name)
                                        }
                                    }
                                }
                            }
                        }
                        Button("Sign out", role: .destructive) {
                            store.shutdown()
                            sessionStore.signOut()
                        }
                    } label: {
                        Image(systemName: "person.circle")
                    }
                }
            }
            .refreshable {
                await store.loadInitial()
            }
            #if DEBUG
            // Test scaffolding: lets simulator automation (which can't tap) deep-open a channel
            // via SIMCTL_CHILD_JUNGLE_AUTO_OPEN=<channelId> at launch.
            // (see modifier below)
            .onAppear {
                if let auto = ProcessInfo.processInfo.environment["JUNGLE_AUTO_OPEN"], !auto.isEmpty {
                    path.append(auto)
                }
            }
            #endif
        }
    }

    private var workspaceName: String {
        sessionStore.me?.memberships
            .first { $0.workspace.id == sessionStore.session?.workspaceId }?
            .workspace.name ?? "Jungle"
    }

    // A notification tap routed here from the shell: open that channel (and thread).
    private func consumePendingLink() {
        guard let link = store.pendingChannelLink else { return }
        store.pendingChannelLink = nil
        path.append(link.channelId)
    }

    // Humans/agents I don't have a DM channel with yet (the sidebar People list).
    private var peopleWithoutDM: [Participant] {
        let dmHandles = Set(store.channels.filter(\.isDM).compactMap(\.dmWith))
        return store.people.filter { $0.id != store.participantId && !dmHandles.contains($0.handle) }
    }
}

// A section label on the forest sidebar (the web's muted uppercase headers).
struct SidebarSectionHeader: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(JungleTheme.sidebarForeground.opacity(0.45))
            .listRowInsets(EdgeInsets(top: 14, leading: 16, bottom: 4, trailing: 16))
    }
}

private struct ChannelRow: View {
    @Environment(AppStore.self) private var store
    let channel: Channel

    private var unread: Int { channel.unreadCount ?? 0 }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: channel.isDM ? "at" : "number")
                .foregroundStyle(JungleTheme.sidebarForeground.opacity(0.5))
                .font(.footnote)
            Text(channel.isDM ? (channel.dmWith ?? channel.name) : channel.name)
                .fontWeight(unread > 0 ? .semibold : .regular)
                .foregroundStyle(unread > 0 ? JungleTheme.sidebarAccentForeground : JungleTheme.sidebarForeground)
            if hasWorkingAgent {
                WorkingDots(color: JungleTheme.sidebarPrimary)
            }
            Spacer()
            if unread > 0 {
                Text("\(unread)")
                    .font(.caption2.bold())
                    .foregroundStyle((channel.hasMention ?? false) ? .white : JungleTheme.sidebarPrimaryForeground)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(
                        (channel.hasMention ?? false) ? JungleTheme.destructive : JungleTheme.sidebarPrimary,
                        in: Capsule())
            }
        }
    }

    // Any member agent currently running a turn whose home is this channel.
    private var hasWorkingAgent: Bool {
        _ = store.liveTurns.liveVersion // re-derive on the throttled tick
        guard let agentIds = channel.memberAgentIds else { return false }
        return agentIds.contains { agentId in
            guard let turn = store.liveTurns.liveTurns[agentId], !turn.done else { return false }
            return turn.context?.channelId == channel.id
        }
    }
}

// Identifiable wrapper for the app-level profile sheet.
struct ProfileRef: Identifiable {
    var id: String
}

@MainActor
private func totalUnread(_ store: AppStore) -> Int {
    store.channels.reduce(0) { $0 + ($1.unreadCount ?? 0) }
        + store.unreadThreads.reduce(0) { $0 + $1.unreadCount }
}

// The More tab: the web's remaining sidebar destinations.
struct MoreView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink {
                    DeliverablesView()
                } label: {
                    Label("Deliverables", systemImage: "shippingbox")
                }
                NavigationLink {
                    ScheduledView()
                } label: {
                    Label("Scheduled", systemImage: "calendar.badge.clock")
                }
                NavigationLink {
                    EnvironmentsView()
                } label: {
                    Label("Environments", systemImage: "desktopcomputer")
                }
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
            .navigationTitle("More")
        }
    }
}

// The sidebar "agent is working" indicator: three pulsing jade dots.
struct WorkingDots: View {
    var color: Color = JungleTheme.primary
    @State private var phase = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(color)
                    .frame(width: 4, height: 4)
                    .opacity(phase ? 1 : 0.3)
                    .animation(
                        .easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2),
                        value: phase)
            }
        }
        .onAppear { phase = true }
    }
}
