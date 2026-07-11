import SwiftUI

// Pushes a thread from a channel timeline.
struct ThreadRef: Hashable {
    var channelId: String
    var rootId: String
}

// One conversation: grouped message timeline + composer — the counterpart of the web's
// MessageList.tsx + Composer.tsx.
struct ChatView: View {
    @Environment(AppStore.self) private var store
    let channelId: String

    private var channel: Channel? {
        store.channels.first { $0.id == channelId }
    }

    // Top-level timeline: messages plus thread replies echoed to the channel.
    private var timeline: [Message] {
        store.messages.filter { $0.threadRootId == nil || $0.alsoToChannel }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(timeline.enumerated()), id: \.element.id) { index, message in
                            MessageRow(
                                message: message,
                                grouped: isGrouped(index: index),
                                sender: store.people.first { $0.id == message.senderId },
                                onOpenThread: { openThread = ThreadRef(channelId: channelId, rootId: $0.threadRootId ?? $0.id) })
                        }
                    }
                    .padding(.vertical, 8)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: timeline.last?.id) { _, lastId in
                    if let lastId {
                        withAnimation { proxy.scrollTo(lastId, anchor: .bottom) }
                    }
                }
            }

            // Pending tool confirmations for this channel, inline above the composer.
            let channelConfirms = store.confirms.filter { $0.channelId == channelId }
            if !channelConfirms.isEmpty {
                VStack(spacing: 8) {
                    ForEach(channelConfirms) { confirm in
                        ConfirmCard(confirm: confirm)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            }

            Divider()
            ComposerView(placeholder: "Message \(title)") { body, attachmentIds in
                try await store.post(
                    channelId: channelId,
                    body: body,
                    attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $openThread) { ref in
            ThreadView(channelId: ref.channelId, rootId: ref.rootId)
        }
        .sheet(isPresented: $showInfo) {
            ChannelInfoView(channelId: channelId)
        }
        .toolbar {
            // DM with an agent: quick access to its activity + profile (the web's DM header).
            if let agent = dmAgent {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            store.activitySheetAgentId = agent.id
                        } label: {
                            Label("View activity", systemImage: "waveform.path.ecg")
                        }
                        Button {
                            store.profileParticipantId = agent.id
                        } label: {
                            Label("Profile", systemImage: "person.crop.circle")
                        }
                    } label: {
                        AgentStatusBadge(status: store.people.first { $0.id == agent.id }?.status ?? .offline)
                    }
                }
            } else {
                // Channel: header info (roster, members, Slack link, delete).
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showInfo = true
                    } label: {
                        Image(systemName: "info.circle")
                    }
                }
            }
        }
        .task(id: channelId) {
            await store.openChannel(channelId)
            #if DEBUG
            // Test scaffolding (paired with JUNGLE_AUTO_OPEN): simulator automation can't type,
            // so SIMCTL_CHILD_JUNGLE_AUTO_SEND=<text> posts once into the auto-opened channel.
            if let text = ProcessInfo.processInfo.environment["JUNGLE_AUTO_SEND"],
               !text.isEmpty, !Self.autoSent {
                Self.autoSent = true
                try? await store.post(channelId: channelId, body: text)
            }
            #endif
        }
        .onDisappear {
            if store.selectedChannelId == channelId {
                store.closeChannel()
            }
        }
    }

    @State private var openThread: ThreadRef?
    @State private var showInfo = false
    #if DEBUG
    @MainActor static var autoSent = false
    #endif

    // The agent on the other side of this DM, when there is one.
    private var dmAgent: Participant? {
        guard let channel, channel.isDM, let handle = channel.dmWith else { return nil }
        let agent = store.people.first { $0.handle == handle }
        return agent?.kind == .agent ? agent : nil
    }

    private var title: String {
        guard let channel else { return "" }
        return channel.isDM ? "@\(channel.dmWith ?? channel.name)" : "#\(channel.name)"
    }

    // Slack-style grouping: consecutive messages from the same sender within 5 minutes
    // collapse into one block (no repeated avatar/header).
    private func isGrouped(index: Int) -> Bool {
        guard index > 0 else { return false }
        let m = timeline[index]
        let prev = timeline[index - 1]
        guard prev.senderId == m.senderId else { return false }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let a = iso.date(from: prev.createdAt), let b = iso.date(from: m.createdAt) else { return false }
        return b.timeIntervalSince(a) < 300
    }

}

struct MessageRow: View {
    let message: Message
    let grouped: Bool
    let sender: Participant?
    var onOpenThread: ((Message) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped {
                Spacer().frame(width: 36)
            } else {
                AvatarView(handle: message.senderHandle, kind: sender?.kind ?? .human)
            }
            VStack(alignment: .leading, spacing: 2) {
                if !grouped {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(message.senderHandle)
                            .font(.subheadline.weight(.semibold))
                        Text(Self.timeString(message.createdAt))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                MessageBody(text: message.body)
                if !message.attachments.isEmpty {
                    AttachmentList(attachments: message.attachments)
                }
                if message.replyCount > 0 {
                    Button {
                        onOpenThread?(message)
                    } label: {
                        Text("\(message.replyCount) \(message.replyCount == 1 ? "reply" : "replies")")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                }
                MessageTurnChips(messageId: message.id)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.top, grouped ? 1 : 8)
        .id(message.id)
    }

    static func timeString(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

// Message body: GFM markdown with code highlighting and @mention badges.
struct MessageBody: View {
    @Environment(AppStore.self) private var store
    let text: String

    var body: some View {
        MarkdownText(
            text: text,
            mentionHandles: Set(store.people.map { $0.handle.lowercased() }))
            .environment(\.openURL, OpenURLAction { url in
                if url.scheme == "mention" {
                    let handle = url.host() ?? url.absoluteString.replacingOccurrences(of: "mention://", with: "")
                    if let person = store.people.first(where: { $0.handle.lowercased() == handle.lowercased() }) {
                        store.profileParticipantId = person.id
                    }
                    return .handled
                }
                return .systemAction
            })
    }
}

struct AvatarView: View {
    let handle: String
    let kind: Kind

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(color.opacity(0.2))
            Text(String(handle.prefix(2)).uppercased())
                .font(.caption.bold())
                .foregroundStyle(color)
        }
        .frame(width: 36, height: 36)
    }

    private var color: Color {
        kind == .agent ? .green : .blue
    }
}

struct AttachmentList: View {
    @Environment(SessionStore.self) private var sessionStore
    let attachments: [Attachment]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments) { attachment in
                if attachment.mime.hasPrefix("image/"), let url = resolvedURL(attachment) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fit)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                            .frame(height: 140)
                    }
                    .frame(maxWidth: 260, maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    Label {
                        VStack(alignment: .leading) {
                            Text(attachment.filename).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "doc")
                    }
                    .font(.callout)
                    .padding(8)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(.top, 2)
    }

    // Attachment urls come back origin-relative (signed path); resolve against the API base.
    private func resolvedURL(_ attachment: Attachment) -> URL? {
        guard let path = attachment.url else { return nil }
        return URL(string: sessionStore.environment.apiBase.absoluteString + path)
    }
}
