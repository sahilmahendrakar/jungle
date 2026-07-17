import SwiftUI

// The durable "what agents shipped" feed — the port of Deliverables.tsx. Newest first,
// paged backwards; live prepends ride the deliverable_created WS event.
struct DeliverablesView: View {
    @Environment(AppStore.self) private var store

    @State private var reachedEnd = false
    @State private var loading = false

    var body: some View {
        List {
            ForEach(store.deliverables) { deliverable in
                DeliverableRow(deliverable: deliverable)
            }
            if !store.deliverables.isEmpty && !reachedEnd {
                Button {
                    Task { await loadMore() }
                } label: {
                    if loading { ProgressView() } else { Text("Load more") }
                }
            }
            if store.deliverables.isEmpty {
                ContentUnavailableView(
                    "No deliverables yet",
                    systemImage: "shippingbox",
                    description: Text("PRs, docs, and issues agents ship show up here."))
            }
        }
        .navigationTitle("Deliverables")
        .task {
            if store.deliverables.isEmpty {
                store.deliverables = (try? await store.api.listDeliverables(limit: 30)) ?? []
                reachedEnd = store.deliverables.count < 30
            }
        }
        .refreshable {
            store.deliverables = (try? await store.api.listDeliverables(limit: 30)) ?? []
            reachedEnd = store.deliverables.count < 30
        }
    }

    private func loadMore() async {
        guard let oldest = store.deliverables.map(\.id).min() else { return }
        loading = true
        defer { loading = false }
        let page = (try? await store.api.listDeliverables(before: oldest, limit: 30)) ?? []
        if page.isEmpty {
            reachedEnd = true
        } else {
            store.deliverables.append(contentsOf: page.filter { d in !store.deliverables.contains { $0.id == d.id } })
        }
    }
}

struct DeliverableRow: View {
    let deliverable: Deliverable
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let url = URL(string: deliverable.url) {
                openURL(url)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(deliverable.title ?? deliverable.url)
                        .font(.callout.weight(.medium))
                        .lineLimit(2)
                    Text("@\(deliverable.agentHandle) · \(kindLabel) · \(channelLabel)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var channelLabel: String {
        deliverable.channelKind == "dm" ? "DM" : "#\(deliverable.channelName)"
    }

    private var icon: String {
        switch deliverable.kind {
        case .githubPr: return "arrow.triangle.pull"
        case .githubIssue: return "smallcircle.filled.circle"
        case .github: return "chevron.left.forwardslash.chevron.right"
        case .notion: return "doc.text"
        case .googleDoc: return "doc.richtext"
        case .googleDrive: return "externaldrive"
        case .linear: return "line.diagonal"
        case .granola: return "note.text"
        case .unknown: return "link"
        }
    }

    private var kindLabel: String {
        switch deliverable.kind {
        case .githubPr: return "Pull request"
        case .githubIssue: return "Issue"
        case .github: return "GitHub"
        case .notion: return "Notion"
        case .googleDoc: return "Google Doc"
        case .googleDrive: return "Drive"
        case .linear: return "Linear"
        case .granola: return "Granola"
        case .unknown: return "Link"
        }
    }
}
