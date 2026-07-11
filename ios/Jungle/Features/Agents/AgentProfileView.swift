import SwiftUI

// One participant's profile — the native counterpart of panels.tsx's ParticipantProfilePanel.
// For agents: live status, context-window meter with Compact / Clear-context actions, memory
// viewer (refetched on agent_memory_changed stamps), and the model/mode/effort/persona
// editors. For humans: the basics.
struct AgentProfileView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let participantId: String

    @State private var memory: String?
    @State private var memoryStamp: String?
    @State private var busyAction: String?
    @State private var notice: String?
    @State private var persona = ""
    @State private var personaDirty = false
    @State private var showActivity = false

    private var person: Participant? {
        store.people.first { $0.id == participantId }
    }

    var body: some View {
        NavigationStack {
            if let person {
                List {
                    header(person)
                    if person.kind == .agent {
                        contextSection(person)
                        configSection(person)
                        personaSection(person)
                        memorySection(person)
                    }
                }
                .navigationTitle(person.displayName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
                .task(id: person.memoryChangedAt) {
                    guard person.kind == .agent else { return }
                    if let result = try? await store.api.getAgentMemory(id: person.id) {
                        memory = result.memory
                        memoryStamp = result.updatedAt
                    }
                }
                .sheet(isPresented: $showActivity) {
                    AgentActivityView(agent: person)
                }
            } else {
                ContentUnavailableView("Participant not found", systemImage: "person.slash")
            }
        }
    }

    private func header(_ person: Participant) -> some View {
        Section {
            HStack(spacing: 12) {
                AvatarView(handle: person.handle, kind: person.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(person.displayName).font(.headline)
                    Text("@\(person.handle)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if person.kind == .agent {
                    AgentStatusBadge(status: person.status ?? .offline)
                }
            }
            if person.kind == .agent {
                Button {
                    showActivity = true
                } label: {
                    Label("View activity", systemImage: "waveform.path.ecg")
                }
            }
            if let notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // The context-window meter + Compact / Clear (the web's usage gauge + buttons).
    private func contextSection(_ person: Participant) -> some View {
        Section("Context window") {
            if let tokens = person.contextTokens, let max = person.contextMaxTokens, max > 0 {
                let fraction = min(1, Double(tokens) / Double(max))
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: fraction)
                        .tint(fraction > 0.8 ? .red : fraction > 0.6 ? .orange : .green)
                    Text("\(tokens / 1000)k of \(max / 1000)k tokens (\(Int(fraction * 100))%)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No usage reported yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button {
                    Task { await run("compact") { try await store.api.compactAgent(id: person.id) } }
                } label: {
                    if busyAction == "compact" { ProgressView() } else { Text("Compact") }
                }
                .buttonStyle(.bordered)
                Button(role: .destructive) {
                    Task { await run("clear") { try await store.api.clearAgentContext(id: person.id) } }
                } label: {
                    if busyAction == "clear" { ProgressView() } else { Text("Clear context") }
                }
                .buttonStyle(.bordered)
            }
            .disabled(busyAction != nil)
        }
    }

    private func configSection(_ person: Participant) -> some View {
        Section("Configuration") {
            Picker("Model", selection: Binding(
                get: { person.model ?? modelCatalog[0].id },
                set: { newModel in Task { await patch(model: newModel) } }
            )) {
                ForEach(modelCatalog) { entry in
                    Text(entry.label).tag(entry.id)
                }
            }
            Picker("Mode", selection: Binding(
                get: { person.mode },
                set: { newMode in Task { await patch(mode: newMode) } }
            )) {
                ForEach(sdkModes, id: \.self) { mode in
                    Text(mode).tag(mode)
                }
            }
            if catalogEntry(model: person.model)?.supportsEffort != false {
                Picker("Effort", selection: Binding(
                    get: { person.effort },
                    set: { newEffort in Task { await patch(effort: newEffort) } }
                )) {
                    ForEach(effortLevels, id: \.self) { level in
                        Text(level).tag(level)
                    }
                }
            }
        }
    }

    private func personaSection(_ person: Participant) -> some View {
        Section("Persona") {
            TextField("Role / personality for this agent's system prompt", text: $persona, axis: .vertical)
                .lineLimit(3...8)
                .onAppear {
                    if !personaDirty { persona = person.persona ?? "" }
                }
                .onChange(of: persona) { _, _ in personaDirty = true }
            if personaDirty && persona != (person.persona ?? "") {
                Button("Save persona") {
                    Task { await patch(persona: persona) }
                }
                .disabled(persona.count > personaMaxLength)
            }
        }
    }

    private func memorySection(_ person: Participant) -> some View {
        Section("Memory") {
            if let memory, !memory.isEmpty {
                MarkdownText(text: memory, mentionHandles: [])
                    .font(.caption)
            } else {
                Text("No memory yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func run(_ name: String, _ action: () async throws -> AgentActionResult) async {
        busyAction = name
        notice = nil
        defer { busyAction = nil }
        do {
            let result = try await action()
            if result.waking == true {
                notice = "Agent is waking — the \(name) runs once it reconnects."
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    private func patch(
        mode: String? = nil, model: String? = nil, effort: String? = nil, persona: String? = nil
    ) async {
        do {
            let updated = try await store.api.updateAgent(
                id: participantId, mode: mode, model: model, effort: effort, persona: persona)
            store.handle(.participantUpdated(updated))
            if persona != nil { personaDirty = false }
        } catch {
            notice = error.localizedDescription
        }
    }
}
