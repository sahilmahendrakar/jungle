import SwiftUI

// A pending tool confirmation from an always-ask agent — the ConfirmCard from panels.tsx.
// Allow/Deny → POST /api/agents/confirm; a 404 means it already resolved or timed out
// server-side (10-min auto-deny) — refresh quietly rather than erroring.
struct ConfirmCard: View {
    @Environment(AppStore.self) private var store
    let confirm: ToolConfirmation

    @State private var busy = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(.orange)
                Text("@\(confirm.agentHandle) wants to run ")
                    .font(.callout)
                + Text(confirm.tool)
                    .font(.callout.weight(.semibold).monospaced())
            }
            Button {
                expanded.toggle()
            } label: {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(confirm.input.jsonString(pretty: expanded))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 3)
                        .multilineTextAlignment(.leading)
                        .padding(8)
                }
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)

            HStack {
                Button {
                    Task { await decide("allow") }
                } label: {
                    Label("Allow", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive) {
                    Task { await decide("deny") }
                } label: {
                    Label("Deny", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .disabled(busy)
        }
        .padding(12)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.orange.opacity(0.3), lineWidth: 1))
    }

    private func decide(_ decision: String) async {
        busy = true
        defer { busy = false }
        do {
            try await store.api.confirmToolCall(confirmId: confirm.confirmId, decision: decision)
        } catch let error as APIError where error.isNotFound {
            // Already resolved elsewhere or auto-denied on timeout.
        } catch {
            return // keep the card so the user can retry
        }
        store.confirms.removeAll { $0.confirmId == confirm.confirmId }
        await store.refreshConfirms()
    }
}

// The approvals inbox — the port of Approvals.tsx. Badge count rides the tab item.
struct ApprovalsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            Group {
                if store.confirms.isEmpty {
                    ContentUnavailableView(
                        "No pending approvals",
                        systemImage: "checkmark.seal",
                        description: Text("Tool calls that need your sign-off show up here."))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(store.confirms) { confirm in
                                ConfirmCard(confirm: confirm)
                            }
                        }
                        .padding(12)
                    }
                }
            }
            .navigationTitle("Approvals")
            .refreshable {
                await store.refreshConfirms()
            }
        }
    }
}
