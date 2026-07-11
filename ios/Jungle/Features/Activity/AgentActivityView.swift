import SwiftUI

// The full Activity surface for one agent: live transcript + steer box + Stop — the native
// counterpart of AgentActivityPanel.tsx. Live frames buffer into the store only while this
// view is open (store.activityAgentId gates it); history pages in from the events API and
// merges by id.
struct AgentActivityView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let agent: Participant

    @State private var backfilled: [AgentEvent] = []
    @State private var loadingMore = false
    @State private var reachedStart = false
    @State private var stopping = false

    private var allEvents: [AgentEvent] {
        SdkEvents.mergeEvents(backfilled, store.activityEvents)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    if !reachedStart && !allEvents.isEmpty {
                        Button {
                            Task { await loadMore() }
                        } label: {
                            if loadingMore {
                                ProgressView()
                            } else {
                                Text("Load earlier activity")
                                    .font(.caption)
                            }
                        }
                        .padding(.top, 8)
                    }
                    TranscriptView(events: allEvents)
                }
                .defaultScrollAnchor(.bottom)

                Divider()
                ComposerView(placeholder: "Steer @\(agent.handle)", onSend: { body, _ in
                    try await store.steer(agent: agent, body: body)
                }, accessory: {
                    if agent.status == .working {
                        Button {
                            Task {
                                stopping = true
                                defer { stopping = false }
                                _ = try? await store.api.interruptAgent(id: agent.id)
                            }
                        } label: {
                            Image(systemName: stopping ? "hourglass" : "stop.circle.fill")
                                .font(.system(size: 24))
                                .foregroundStyle(.red)
                        }
                    }
                })
            }
            .navigationTitle("@\(agent.handle)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AgentStatusBadge(status: liveStatus)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            store.openActivity(agentId: agent.id)
            await loadInitial()
        }
        .onDisappear {
            store.closeActivity()
        }
    }

    private var liveStatus: AgentStatus {
        store.people.first { $0.id == agent.id }?.status ?? agent.status ?? .offline
    }

    private func loadInitial() async {
        if let page = try? await store.api.fetchAgentEvents(id: agent.id, limit: 200) {
            backfilled = page.events
            reachedStart = page.events.isEmpty
        }
    }

    private func loadMore() async {
        guard let oldest = allEvents.first?.id else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let page = try? await store.api.fetchAgentEvents(id: agent.id, before: oldest, limit: 200) {
            if page.events.isEmpty {
                reachedStart = true
            } else {
                backfilled = SdkEvents.mergeEvents(page.events, backfilled)
            }
        }
    }
}

struct AgentStatusBadge: View {
    let status: AgentStatus

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var color: Color {
        switch status {
        case .working: return .green
        case .idle: return .blue
        case .waking: return .orange
        case .sleeping: return .gray
        case .offline, .unknown: return .gray.opacity(0.5)
        }
    }

    private var label: String {
        switch status {
        case .working: return "working"
        case .idle: return "idle"
        case .waking: return "waking"
        case .sleeping: return "sleeping"
        case .offline: return "offline"
        case .unknown: return "unknown"
        }
    }
}
