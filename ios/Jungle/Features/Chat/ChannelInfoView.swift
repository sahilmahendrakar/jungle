import SwiftUI

// Channel details from the header tap — roster with live status (ChannelRoster.tsx), member
// management (MembersDialog), Slack link (SlackLinkDialog), and delete (DeleteChannelDialog).
struct ChannelInfoView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let channelId: String

    @State private var addHandle = ""
    @State private var slackLink: SlackChannelLink?
    @State private var slackChannels: [SlackChannelInfo] = []
    @State private var slackStatus: SlackStatus?
    @State private var confirmDelete = false
    @State private var errorMessage: String?

    private var channel: Channel? {
        store.channels.first { $0.id == channelId }
    }

    private var isSelf: (Participant) -> Bool {
        { $0.id == store.participantId }
    }

    var body: some View {
        NavigationStack {
            List {
                membersSection
                if channel?.isDM == false {
                    slackSection
                    dangerSection
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(channel.map { $0.isDM ? "@\($0.dmWith ?? "DM")" : "#\($0.name)" } ?? "Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                slackLink = try? await store.api.getChannelSlackLink(channelId: channelId)
                slackStatus = try? await store.api.getSlackStatus()
            }
            .confirmationDialog(
                "Delete this channel? Its messages are gone for everyone.",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete channel", role: .destructive) {
                    Task {
                        do {
                            try await store.api.deleteChannel(channelId: channelId)
                            dismiss()
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
            }
        }
    }

    private var membersSection: some View {
        Section("Members") {
            // Agents first, working first — the roster ordering.
            let members = store.members.sorted {
                (order($0), $0.handle) < (order($1), $1.handle)
            }
            ForEach(members) { member in
                Button {
                    store.profileParticipantId = member.id
                } label: {
                    HStack(spacing: 10) {
                        AvatarView(handle: member.handle, kind: member.kind)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(member.displayName)
                            Text("@\(member.handle)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if member.kind == .agent {
                            AgentStatusBadge(status: member.status ?? .offline)
                        }
                    }
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                    if channel?.isDM == false && !isSelf(member) {
                        Button(role: .destructive) {
                            Task {
                                try? await store.api.removeChannelMember(channelId: channelId, participantId: member.id)
                            }
                        } label: {
                            Label("Remove", systemImage: "person.badge.minus")
                        }
                    }
                }
            }
            if channel?.isDM == false {
                HStack {
                    TextField("Add by handle", text: $addHandle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Add") {
                        Task {
                            do {
                                _ = try await store.api.addChannelMember(
                                    channelId: channelId,
                                    handle: addHandle.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "@", with: ""))
                                addHandle = ""
                                errorMessage = nil
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    }
                    .disabled(addHandle.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func order(_ p: Participant) -> Int {
        if p.kind == .agent {
            return p.status == .working ? 0 : 1
        }
        return 2
    }

    private var slackSection: some View {
        Section("Slack mirror") {
            if let link = slackLink {
                LabeledContent("Linked to", value: "#\(link.slackChannelName ?? link.slackChannelId)")
                if link.status == "error", let lastError = link.lastError {
                    Text(lastError).font(.caption).foregroundStyle(.red)
                }
                Button("Unlink", role: .destructive) {
                    Task {
                        try? await store.api.unlinkChannelFromSlack(channelId: channelId)
                        slackLink = nil
                    }
                }
            } else if slackStatus?.installed == true {
                if slackChannels.isEmpty {
                    Button("Choose a Slack channel…") {
                        Task {
                            slackChannels = (try? await store.api.listSlackChannels()) ?? []
                        }
                    }
                } else {
                    ForEach(slackChannels.filter { !$0.isPrivate }) { sc in
                        Button("#\(sc.name)") {
                            Task {
                                do {
                                    slackLink = try await store.api.linkChannelToSlack(
                                        channelId: channelId, slackChannelId: sc.id)
                                    slackChannels = []
                                } catch {
                                    errorMessage = error.localizedDescription
                                }
                            }
                        }
                    }
                }
            } else {
                Text("Connect Slack in Settings to mirror this channel.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var dangerSection: some View {
        Section {
            Button("Delete channel", role: .destructive) {
                confirmDelete = true
            }
        }
    }
}

// Create a channel or DM — the port of NewChannelDialog.tsx.
struct NewChannelView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var selectedHandles = Set<String>()
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Channel name") {
                    TextField("e.g. growth", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Members") {
                    ForEach(store.people.filter { $0.id != store.participantId }) { p in
                        Button {
                            if selectedHandles.contains(p.handle) {
                                selectedHandles.remove(p.handle)
                            } else {
                                selectedHandles.insert(p.handle)
                            }
                        } label: {
                            HStack {
                                AvatarView(handle: p.handle, kind: p.kind)
                                Text("@\(p.handle)")
                                Spacer()
                                if selectedHandles.contains(p.handle) {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
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
                        if busy { ProgressView() } else { Text("Create channel") }
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("New channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func create() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let channel = try await store.api.createChannel(
                name: name.trimmingCharacters(in: .whitespaces),
                kind: "channel",
                memberHandles: Array(selectedHandles))
            await store.reloadChannels(selectId: channel.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
