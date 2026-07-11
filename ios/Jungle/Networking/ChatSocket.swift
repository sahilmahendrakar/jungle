import Foundation

// Owns the single app WebSocket — the native counterpart of useChatSocket.ts's connect /
// auto-reconnect loop. Decodes ServerEvent frames and delivers them (and lifecycle notes)
// to a MainActor handler; exposes post() for the one client->server frame. Reconnect: flat
// 1.5 s retry like the web, with a fresh auth query string minted per attempt so a token
// that expired while disconnected never poisons the handshake.
actor ChatSocket {
    enum LifecycleEvent: Sendable {
        case connected // socket opened (fire backfill: open-channel history, confirms, channels)
        case disconnected
    }

    private let environment: BackendEnvironment
    private let session: Session
    private let tokenProvider: AuthTokenProvider
    private let onEvent: @MainActor @Sendable (ServerEvent) -> Void
    private let onLifecycle: @MainActor @Sendable (LifecycleEvent) -> Void

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var stopped = true
    private var authFailed = false

    init(
        environment: BackendEnvironment,
        session: Session,
        tokenProvider: AuthTokenProvider,
        onEvent: @escaping @MainActor @Sendable (ServerEvent) -> Void,
        onLifecycle: @escaping @MainActor @Sendable (LifecycleEvent) -> Void
    ) {
        self.environment = environment
        self.session = session
        self.tokenProvider = tokenProvider
        self.onEvent = onEvent
        self.onLifecycle = onLifecycle
    }

    func start() {
        guard stopped else { return }
        stopped = false
        Task { await connect() }
    }

    // Scene went background / sign-out: drop the socket without scheduling a retry.
    func stop() {
        stopped = true
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    func post(_ frame: ClientPostFrame) async throws {
        guard let task else {
            throw APIError(message: "not connected")
        }
        let data = try JSONEncoder().encode(frame)
        try await task.send(.string(String(data: data, encoding: .utf8)!))
    }

    private func connect() async {
        guard !stopped else { return }

        // Fresh auth per attempt. Dev mode: ?participantId= (names the workspace too).
        // Firebase mode: ?token= (+ &workspaceId=), force-refreshed after an auth close (4001).
        var qs: String
        switch session.mode {
        case .devBypass:
            qs = "participantId=\(session.participantId.queryEncoded)"
        case .firebase:
            let token = (try? await tokenProvider.idToken(forceRefresh: authFailed)) ?? nil
            authFailed = false
            qs = "token=\((token ?? "").queryEncoded)"
            if let ws = session.workspaceId {
                qs += "&workspaceId=\(ws.queryEncoded)"
            }
        }
        guard !stopped, let url = URL(string: "\(environment.wsBase.absoluteString)/?\(qs)") else { return }

        let wsTask = URLSession.shared.webSocketTask(with: url)
        task = wsTask
        wsTask.resume()

        receiveLoop = Task { await self.receiveLoop(on: wsTask) }
    }

    private func receiveLoop(on wsTask: URLSessionWebSocketTask) async {
        var opened = false
        while !Task.isCancelled {
            do {
                let message = try await wsTask.receive()
                // First frame received = the handshake succeeded; report connected so the store
                // runs its backfill. (The server always sends `connected` first.)
                if !opened {
                    opened = true
                    await onLifecycle(.connected)
                }
                let data: Data?
                switch message {
                case .string(let text): data = text.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: data = nil
                }
                if let data, let event = try? JSONDecoder().decode(ServerEvent.self, from: data) {
                    await onEvent(event)
                }
            } catch {
                break
            }
        }
        guard !Task.isCancelled else { return }
        // 4001 = auth failure: mint a force-refreshed token on the next attempt.
        if wsTask.closeCode.rawValue == 4001 { authFailed = true }
        if opened { await onLifecycle(.disconnected) }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !stopped, reconnectTask == nil else { return }
        reconnectTask = Task {
            try? await Task.sleep(for: .milliseconds(1500))
            reconnectTask = nil
            guard !Task.isCancelled else { return }
            await connect()
        }
    }
}
