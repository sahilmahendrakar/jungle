import SwiftUI

// Mission control — the port of AgentsHome.tsx: every agent with live status, pending
// approvals, and recent deliverables, plus the Add Agent flow.
struct AgentsHomeView: View {
    @Environment(AppStore.self) private var store

    @State private var showAddAgent = false

    private var agents: [Participant] {
        store.people.filter { $0.kind == .agent }
            .sorted { ($0.status == .working ? 0 : 1, $0.handle) < ($1.status == .working ? 0 : 1, $1.handle) }
    }

    var body: some View {
        NavigationStack {
            List {
                if !store.confirms.isEmpty {
                    Section("Needs your approval") {
                        ForEach(store.confirms) { confirm in
                            ConfirmCard(confirm: confirm)
                                .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                                .listRowSeparator(.hidden)
                        }
                    }
                }

                Section("Agents") {
                    if agents.isEmpty {
                        Text("No agents yet — add one to get started.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(agents) { agent in
                        Button {
                            store.profileParticipantId = agent.id
                        } label: {
                            AgentRow(agent: agent)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if !store.deliverables.isEmpty {
                    Section("Recent deliverables") {
                        ForEach(store.deliverables.prefix(5)) { deliverable in
                            DeliverableRow(deliverable: deliverable)
                        }
                    }
                }
            }
            .navigationTitle("Agents")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showAddAgent = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAddAgent) {
                AddAgentView()
            }
            .task {
                if store.deliverables.isEmpty {
                    store.deliverables = (try? await store.api.listDeliverables(limit: 10)) ?? []
                }
            }
            .refreshable {
                await store.loadInitial()
                store.deliverables = (try? await store.api.listDeliverables(limit: 10)) ?? []
            }
        }
    }
}

struct AgentRow: View {
    @Environment(AppStore.self) private var store
    let agent: Participant

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(handle: agent.handle, kind: .agent)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName).font(.body.weight(.medium))
                HStack(spacing: 4) {
                    Text("@\(agent.handle)")
                    if agent.status == .working {
                        Text("· \(workingSummary)")
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            AgentStatusBadge(status: agent.status ?? .offline)
        }
    }

    private var workingSummary: String {
        _ = store.liveTurns.liveVersion
        guard let turn = store.liveTurns.liveTurns[agent.id], !turn.done else { return "working" }
        let items = SdkEvents.buildItems(turn.events)
        return items.isEmpty ? "working" : SdkEvents.liveSummary(items)
    }
}

// Create an agent — the port of AddAgentDialog.tsx: handle/name, optional GitHub repo
// integration, model, environment (cloud / self-hosted device).
struct AddAgentView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss

    @State private var handle = ""
    @State private var displayName = ""
    @State private var model = modelCatalog[0].id
    @State private var attachGithub = false
    @State private var repo = ""
    @State private var devices: [RunnerHost] = []
    @State private var hostId: String? // nil = cloud
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    TextField("handle (e.g. repo-bot)", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Display name", text: $displayName)
                }
                Section("Model") {
                    Picker("Model", selection: $model) {
                        ForEach(modelCatalog) { entry in
                            VStack(alignment: .leading) {
                                Text(entry.label)
                            }.tag(entry.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("GitHub") {
                    Toggle("Attach a repository", isOn: $attachGithub)
                    if attachGithub {
                        TextField("owner/name", text: $repo)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                    }
                }
                if !devices.isEmpty {
                    Section("Environment") {
                        Picker("Runs on", selection: $hostId) {
                            Text("Cloud").tag(String?.none)
                            ForEach(devices) { device in
                                Text("\(device.name)\(device.online ? "" : " (offline)")")
                                    .tag(String?.some(device.id))
                            }
                        }
                    }
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        Task { await create() }
                    } label: {
                        if busy { ProgressView() } else { Text("Create agent") }
                    }
                    .disabled(busy || !isValidHandle(handle) || (attachGithub && repo.isEmpty))
                }
            }
            .navigationTitle("New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                devices = (try? await store.api.listDevices()) ?? []
            }
            .onChange(of: handle) { _, new in
                if displayName.isEmpty || displayName == handleToName(String(new.dropLast())) {
                    displayName = handleToName(new)
                }
            }
        }
    }

    private func handleToName(_ h: String) -> String {
        h.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    private func create() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let integrations: [(key: String, config: [String: JSONValue])] =
                attachGithub && !repo.isEmpty ? [(key: "github", config: ["repo": .string(repo)])] : []
            let agent = try await store.api.createAgent(
                handle: handle,
                displayName: displayName.isEmpty ? handleToName(handle) : displayName,
                integrations: integrations,
                model: model,
                runnerProvider: hostId != nil ? "self_hosted" : nil,
                hostId: hostId)
            store.people.append(agent)
            await store.reloadChannels()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
