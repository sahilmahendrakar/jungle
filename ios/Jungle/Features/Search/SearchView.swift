import SwiftUI

// Server full-text search across my channels — the port of SearchDialog.tsx (the web's ⌘K),
// surfaced via .searchable on Home. Result taps jump to the channel.
struct SearchResultsView: View {
    @Environment(AppStore.self) private var store
    let query: String
    let onOpen: (SearchResult) -> Void

    @State private var results: [SearchResult] = []
    @State private var searched = false

    var body: some View {
        Group {
            if results.isEmpty && searched {
                ContentUnavailableView.search(text: query)
            } else {
                List(results, id: \.messageId) { result in
                    Button {
                        onOpen(result)
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(result.channelKind == "dm" ? "@\(result.dmWith ?? "DM")" : "#\(result.channelName)")
                                    .font(.caption.weight(.semibold))
                                Spacer()
                                Text(MessageRow.timeString(result.createdAt))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text("\(result.senderHandle): \(result.body)")
                                .font(.callout)
                                .lineLimit(3)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .task(id: query) {
            // Small debounce so we don't hit the server per keystroke.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            results = (try? await store.api.searchMessages(query: query)) ?? []
            searched = true
        }
    }
}
