import Foundation
import Observation

// The single dispatch target for the app WebSocket and the holder of all chat state — the
// native counterpart of App.tsx's state + useChatSocket.ts's onmessage switch. Where the web
// reads live values through mirror-refs to dodge stale closures, this store just reads its
// own properties.

@MainActor
@Observable
final class AppStore {
    // --- Chat state (the App.tsx useStates) ---
    var channels: [Channel] = []
    var people: [Participant] = []
    var messages: [Message] = [] // the open channel's timeline
    var members: [Participant] = [] // the open channel's members
    var selectedChannelId: String?
    var confirms: [ToolConfirmation] = []
    var deliverables: [Deliverable] = []
    var unreadThreads: [UnreadThread] = []
    var notice: String? // connection banner ("reconnecting…")

    // Full activity transcript buffer: only grows while an agent's Activity view is open
    // (otherwise memory would grow for every agent forever); backfilled from the events API.
    var activityAgentId: String?
    var activityEvents: [AgentEvent] = []

    // Whether the user is looking at the app (scenePhase.active) — the focusedRef twin.
    // Gates mark-read: an open channel in a backgrounded app stays unread.
    var focused = true

    // App-level profile sheet target (the web's setProfileId) — set from mention taps,
    // rosters, chips; presented by the shell.
    var profileParticipantId: String?

    // App-level Activity sheet target (chips, DM header) — presented by the shell.
    var activitySheetAgentId: String?

    // A notification tap waiting to be routed (Home consumes it and navigates).
    struct ChannelLink: Equatable {
        var channelId: String
        var threadRootId: String?
    }
    var pendingChannelLink: ChannelLink?

    let liveTurns = LiveTurnStore()

    let api: APIClient
    private let session: Session
    private var socket: ChatSocket?

    init(api: APIClient, session: Session) {
        self.api = api
        self.session = session
    }

    var participantId: String { session.participantId }

    var selectedChannel: Channel? {
        channels.first { $0.id == selectedChannelId }
    }

    // --- Socket lifecycle ---

    func startSocket(environment: BackendEnvironment, tokenProvider: AuthTokenProvider) {
        guard socket == nil else { return }
        let socket = ChatSocket(
            environment: environment,
            session: session,
            tokenProvider: tokenProvider,
            onEvent: { [weak self] event in self?.handle(event) },
            onLifecycle: { [weak self] event in self?.handleLifecycle(event) })
        self.socket = socket
        Task { await socket.start() }
    }

    // scenePhase-driven: background = drop the socket, foreground = reconnect + backfill.
    func setActive(_ active: Bool) {
        focused = active
        guard let socket else { return }
        Task {
            if active {
                await socket.start()
            } else {
                await socket.stop()
            }
        }
    }

    func shutdown() {
        let socket = socket
        self.socket = nil
        Task { await socket?.stop() }
    }

    private func handleLifecycle(_ event: ChatSocket.LifecycleEvent) {
        switch event {
        case .connected:
            notice = nil
            // Backfill everything that only fans out live: the open channel's history (merged
            // by id, so nothing missed while disconnected is dropped or duplicated), pending
            // confirmations, the channel list + unread threads (their unread state moved).
            if let channelId = selectedChannelId {
                Task {
                    if let history = try? await api.getMessages(channelId: channelId) {
                        guard selectedChannelId == channelId else { return }
                        mergeMessages(history)
                    }
                }
            }
            Task { await refreshConfirms() }
            Task { await reloadChannels() }
            Task { await refreshThreads() }
        case .disconnected:
            notice = "Reconnecting…"
        }
    }

    // --- Initial + refresh loads ---

    func loadInitial() async {
        async let channelsTask = api.listChannels()
        async let peopleTask = api.listParticipants()
        async let threadsTask = api.unreadThreads()
        channels = (try? await channelsTask) ?? []
        people = (try? await peopleTask) ?? []
        unreadThreads = (try? await threadsTask) ?? []
        await refreshConfirms()
    }

    func reloadChannels(selectId: String? = nil) async {
        if let fresh = try? await api.listChannels() {
            channels = fresh
            if let selectId { selectedChannelId = selectId }
        }
    }

    func refreshThreads() async {
        if let fresh = try? await api.unreadThreads() {
            unreadThreads = fresh
        }
    }

    func refreshConfirms() async {
        if let fresh = try? await api.listPendingConfirms() {
            confirms = fresh
        }
    }

    // --- Channel open/close ---

    func openChannel(_ channelId: String) async {
        selectedChannelId = channelId
        messages = []
        members = []
        async let historyTask = api.getMessages(channelId: channelId)
        async let membersTask = api.listChannelMembers(channelId: channelId)
        async let chipsTask = api.getChannelTurnChips(channelId: channelId)
        if let history = try? await historyTask, selectedChannelId == channelId {
            messages = history
        }
        if let members = try? await membersTask, selectedChannelId == channelId {
            self.members = members
        }
        if let chips = try? await chipsTask {
            liveTurns.hydrateChannel(channelId: channelId, turns: chips.turns, queuedRows: chips.queued)
        }
        markRead(channelId)
    }

    func closeChannel() {
        selectedChannelId = nil
        messages = []
        members = []
    }

    // Advance my read marker and zero the sidebar badge (server + local, like the web's markRead).
    func markRead(_ channelId: String) {
        if let i = channels.firstIndex(where: { $0.id == channelId }) {
            channels[i].unreadCount = 0
            channels[i].hasMention = false
        }
        Task { try? await api.markChannelRead(channelId: channelId) }
    }

    private func mergeMessages(_ incoming: [Message]) {
        var byId: [String: Message] = [:]
        for m in messages + incoming { byId[m.id] = m }
        messages = byId.values.sorted { (Int64($0.seq) ?? 0) < (Int64($1.seq) ?? 0) }
    }

    // --- Activity view gating (the web's activityIdRef) ---

    func openActivity(agentId: String) {
        activityAgentId = agentId
        activityEvents = []
    }

    func closeActivity() {
        activityAgentId = nil
        activityEvents = []
    }

    // Steer: a quiet nudge posted to the agent's DM (find-or-create), like the web's onSteer.
    func steer(agent: Participant, body: String) async throws {
        let dm: Channel
        if let existing = channels.first(where: { $0.kind == "dm" && $0.dmWith == agent.handle }) {
            dm = existing
        } else {
            dm = try await api.openDM(otherId: agent.id, participantId: participantId)
            await reloadChannels()
        }
        try await post(channelId: dm.id, body: body)
    }

    // --- Sending (WS-only; there is no REST send) ---

    func post(
        channelId: String,
        body: String?,
        attachmentIds: [String]? = nil,
        threadRootId: String? = nil,
        alsoToChannel: Bool? = nil
    ) async throws {
        guard let socket else { throw APIError(message: "not connected") }
        try await socket.post(ClientPostFrame(
            channelId: channelId,
            body: body,
            clientMsgId: UUID().uuidString,
            attachmentIds: attachmentIds,
            threadRootId: threadRootId,
            alsoToChannel: alsoToChannel))
    }

    // --- The ServerEvent dispatch (port of useChatSocket.ts onmessage, all branches) ---

    func handle(_ event: ServerEvent) {
        switch event {
        case .connected:
            break

        case .error(let message):
            notice = message

        case .agentStatusChanged(let agentId, let status):
            if let i = people.firstIndex(where: { $0.id == agentId }) {
                people[i].status = status
            }

        case .deviceStatusChanged:
            // Account-scoped device up/down; the Environments screen observes this via its own
            // refresh (M4). No chat state changes.
            break

        case .membersChanged(let channelId):
            if channelId == selectedChannelId {
                Task {
                    if let fresh = try? await api.listChannelMembers(channelId: channelId),
                       selectedChannelId == channelId {
                        members = fresh
                    }
                }
            }
            // Refresh the sidebar so a channel I was just added to/removed from shows correctly.
            Task { await reloadChannels() }

        case .channelDeleted(let channelId):
            channels.removeAll { $0.id == channelId }
            if channelId == selectedChannelId { closeChannel() }

        case .slackLinkChanged:
            break // channel header badge (M4)

        case .participantUpdated(let participant):
            if let i = people.firstIndex(where: { $0.id == participant.id }) {
                // Preserve the live status/memory stamp: participant_updated carries the row,
                // not the derived status (the web spreads the update over the existing person).
                let status = people[i].status
                let memoryChangedAt = people[i].memoryChangedAt
                people[i] = participant
                if people[i].status == nil { people[i].status = status }
                people[i].memoryChangedAt = memoryChangedAt
            }

        case .agentContext(let agentId, let tokens, let maxTokens):
            if let i = people.firstIndex(where: { $0.id == agentId }) {
                people[i].contextTokens = tokens
                people[i].contextMaxTokens = maxTokens
                people[i].contextUpdatedAt = ISO8601DateFormatter().string(from: Date())
            }

        case .agentMemoryChanged(let agentId):
            // Stamp so an open profile's Memory section refetches (content doesn't ride the WS).
            if let i = people.firstIndex(where: { $0.id == agentId }) {
                people[i].memoryChangedAt = ISO8601DateFormatter().string(from: Date())
            }

        case .participantDeleted(let participantId):
            // Drop the deleted agent's DM (DMs are keyed by the other member's handle) before
            // removing the participant itself.
            if let gone = people.first(where: { $0.id == participantId }) {
                if let dm = channels.first(where: { $0.kind == "dm" && $0.dmWith == gone.handle }) {
                    if dm.id == selectedChannelId { closeChannel() }
                    channels.removeAll { $0.id == dm.id }
                }
            }
            people.removeAll { $0.id == participantId }
            if profileParticipantId == participantId { profileParticipantId = nil }

        case .agentTurn(let agentId, let turnId, let context):
            liveTurns.ingestLiveEvent(agentId: agentId, turnId: turnId, event: nil, context: context)

        case .agentQueued(let agentId, let context):
            liveTurns.ingestQueued(agentId: agentId, context: context)

        case .agentEvent(let agentId, let turnId, let event, let context):
            // Always feed the bounded live-turn buffer (ambient surfaces)…
            liveTurns.ingestLiveEvent(agentId: agentId, turnId: turnId, event: event, context: context)
            // …but only buffer the full stream while that agent's Activity view is open.
            guard agentId == activityAgentId else { return }
            activityEvents.append(AgentEvent(
                id: Date().timeIntervalSince1970 * 1000 + Double.random(in: 0..<1),
                turnId: turnId,
                event: event,
                createdAt: ISO8601DateFormatter().string(from: Date())))

        case .toolConfirmationRequest(let confirm):
            if !confirms.contains(where: { $0.confirmId == confirm.confirmId }) {
                confirms.append(confirm)
            }

        case .toolConfirmationResolved(let confirmId, _, _, _):
            confirms.removeAll { $0.confirmId == confirmId }

        case .deliverableCreated(let deliverable):
            if !deliverables.contains(where: { $0.id == deliverable.id }) {
                deliverables.insert(deliverable, at: 0)
            }

        case .message(let m):
            handleIncomingMessage(m)

        case .scheduleChanged:
            break // Scheduled screen refetches on its own (M4)

        case .unknown:
            break
        }
    }

    private func handleIncomingMessage(_ m: Message) {
        let isOpen = m.channelId == selectedChannelId
        let isMine = m.senderId == participantId
        // An incoming thread reply (not mine) may change my followed-threads unreads.
        if m.threadRootId != nil && !isMine {
            Task { await refreshThreads() }
        }
        if isOpen && focused {
            // Looking right at this channel — render and keep the read marker current.
            if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
            if !isMine { markRead(m.channelId) }
            return
        }
        if isOpen {
            // Open but not focused — still render, but leave unread until refocus.
            if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
        }
        // Bump unread for channels not being actively read. Skip my own messages; a pure
        // thread reply does NOT count toward the channel badge (it has per-thread unread) —
        // only top-level messages and replies echoed to the channel do.
        if isMine || !(m.threadRootId == nil || m.alsoToChannel) { return }
        let mentionsMe = m.mentions.contains { $0.id == participantId }
        if let i = channels.firstIndex(where: { $0.id == m.channelId }) {
            channels[i].unreadCount = (channels[i].unreadCount ?? 0) + 1
            channels[i].hasMention = (channels[i].hasMention ?? false) || mentionsMe
        }
    }
}
