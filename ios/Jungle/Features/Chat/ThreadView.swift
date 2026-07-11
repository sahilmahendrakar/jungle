import SwiftUI

// One thread: root + replies with its own reply composer — the port of ThreadPanel.tsx.
// History comes from GET /api/channels/:id/threads/:rootId; live replies ride the channel's
// message stream (they land in store.messages while the channel is open) and are merged in.
struct ThreadView: View {
    @Environment(AppStore.self) private var store
    let channelId: String
    let rootId: String

    @State private var fetched: [Message] = []
    @State private var alsoToChannel = false

    // Root + replies, merged from the fetched transcript and any live frames, seq order.
    private var thread: [Message] {
        var byId: [String: Message] = [:]
        for m in fetched { byId[m.id] = m }
        for m in store.messages where m.id == rootId || m.threadRootId == rootId {
            byId[m.id] = m
        }
        return byId.values.sorted { (Int64($0.seq) ?? 0) < (Int64($1.seq) ?? 0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(thread.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            grouped: false,
                            sender: store.people.first { $0.id == message.senderId })
                        if index == 0 && thread.count > 1 {
                            HStack {
                                Text("\(thread.count - 1) \(thread.count == 2 ? "reply" : "replies")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                VStack { Divider() }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                        }
                    }
                }
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)

            Divider()
            ComposerView(placeholder: "Reply in thread", onSend: { body, attachmentIds in
                try await store.post(
                    channelId: channelId,
                    body: body,
                    attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                    threadRootId: rootId,
                    alsoToChannel: alsoToChannel)
            }, accessory: {
                // The web thread composer's "also send to #channel" toggle.
                Button {
                    alsoToChannel.toggle()
                } label: {
                    Image(systemName: alsoToChannel ? "number.circle.fill" : "number.circle")
                        .font(.system(size: 24))
                        .foregroundStyle(alsoToChannel ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                }
            })
        }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            fetched = (try? await store.api.getThread(channelId: channelId, rootId: rootId)) ?? []
            try? await store.api.markThreadRead(rootId: rootId)
            await store.refreshThreads()
        }
        .onChange(of: thread.count) { old, new in
            // A live reply while the thread is open keeps the read marker current.
            guard new > old else { return }
            Task {
                try? await store.api.markThreadRead(rootId: rootId)
                await store.refreshThreads()
            }
        }
    }
}
