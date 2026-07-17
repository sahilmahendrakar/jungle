import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// The message composer — the port of Composer.tsx: @-mention autocomplete, upload-first
// attachments (25 MB / 10-per-message limits from lib/chat.ts), auto-growing field, send.
// Shared by the channel view and the thread reply pane (`accessory` carries the thread's
// "also send to channel" toggle).
struct ComposerView<Accessory: View>: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var sessionStore

    let placeholder: String
    let onSend: (_ body: String, _ attachmentIds: [String]) async throws -> Void
    @ViewBuilder var accessory: () -> Accessory

    @State private var draft = ""
    @State private var pending: [PendingAttachment] = []
    @State private var errorMessage: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @FocusState private var focused: Bool

    struct PendingAttachment: Identifiable {
        let id = UUID()
        var filename: String
        var uploaded: Attachment?
        var failed = false
    }

    var body: some View {
        VStack(spacing: 0) {
            if let suggestions = mentionSuggestions, !suggestions.isEmpty {
                mentionBar(suggestions)
            }
            if !pending.isEmpty {
                attachmentBar
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button {
                        showFileImporter = true
                    } label: {
                        Label("File", systemImage: "doc")
                    }
                    Button {
                        photoPickerPresented = true
                    } label: {
                        Label("Photo or video", systemImage: "photo")
                    }
                } label: {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 24))
                        .foregroundStyle(.secondary)
                }

                TextField(placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18))

                accessory()

                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(!canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .photosPicker(isPresented: $photoPickerPresented, selection: $photoItem, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { await uploadPhoto(item) }
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result {
                Task { await uploadFile(url) }
            }
        }
    }

    @State private var photoPickerPresented = false

    private var canSend: Bool {
        let hasBody = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let uploadsSettled = pending.allSatisfy { $0.uploaded != nil || $0.failed }
        let hasUpload = pending.contains { $0.uploaded != nil }
        return (hasBody || hasUpload) && uploadsSettled
    }

    // --- Mentions (port of lib/chat.ts detectMention, anchored to the end of the draft —
    // the caret's usual home on mobile) ---

    private var activeMentionQuery: String? {
        guard let atIndex = draft.lastIndex(of: "@") else { return nil }
        let after = draft[draft.index(after: atIndex)...]
        guard !after.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        if atIndex > draft.startIndex {
            let before = draft[draft.index(before: atIndex)]
            guard before.isWhitespace || before.isNewline else { return nil }
        }
        return String(after).lowercased()
    }

    private var mentionSuggestions: [Participant]? {
        guard let query = activeMentionQuery else { return nil }
        return store.people
            .filter { query.isEmpty || $0.handle.lowercased().hasPrefix(query) }
            .sorted { ($0.kind == .agent ? 0 : 1, $0.handle) < ($1.kind == .agent ? 0 : 1, $1.handle) }
            .prefix(6)
            .map { $0 }
    }

    private func mentionBar(_ suggestions: [Participant]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions) { p in
                    Button {
                        completeMention(p.handle)
                    } label: {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(p.kind == .agent ? Color.green : Color.blue)
                                .frame(width: 6, height: 6)
                            Text("@\(p.handle)")
                                .font(.callout.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.quaternary.opacity(0.5), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    private func completeMention(_ handle: String) {
        guard let atIndex = draft.lastIndex(of: "@") else { return }
        draft = String(draft[..<atIndex]) + "@\(handle) "
    }

    // --- Attachments (upload-first, like the web) ---

    private func uploadPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            errorMessage = "couldn't load the selected item"
            return
        }
        let mime = item.supportedContentTypes.first?.preferredMIMEType ?? "application/octet-stream"
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "bin"
        await upload(data: data, filename: "photo-\(Int(Date().timeIntervalSince1970)).\(ext)", mime: mime)
    }

    private func uploadFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            errorMessage = "couldn't read the selected file"
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        await upload(data: data, filename: url.lastPathComponent, mime: mime)
    }

    private func upload(data: Data, filename: String, mime: String) async {
        errorMessage = nil
        guard data.count <= attachmentMaxBytes else {
            errorMessage = "attachments are limited to 25 MB"
            return
        }
        guard pending.count < attachmentsPerMessage else {
            errorMessage = "up to \(attachmentsPerMessage) attachments per message"
            return
        }
        let entry = PendingAttachment(filename: filename)
        pending.append(entry)
        do {
            let uploaded = try await sessionStore.api.uploadAttachment(data: data, filename: filename, mime: mime)
            if let i = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[i].uploaded = uploaded
            }
        } catch {
            if let i = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[i].failed = true
            }
            errorMessage = error.localizedDescription
        }
    }

    private var attachmentBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending) { p in
                    HStack(spacing: 6) {
                        if p.failed {
                            Image(systemName: "exclamationmark.triangle").foregroundStyle(.red)
                        } else if p.uploaded == nil {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "paperclip")
                        }
                        Text(p.filename).font(.caption).lineLimit(1)
                        Button {
                            pending.removeAll { $0.id == p.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func send() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let ids = pending.compactMap { $0.uploaded?.id }
        guard !body.isEmpty || !ids.isEmpty else { return }
        let savedDraft = draft
        let savedPending = pending
        draft = ""
        pending = []
        errorMessage = nil
        do {
            // No optimistic echo (matches web): the message appears when it fans back.
            try await onSend(body, ids)
        } catch {
            errorMessage = error.localizedDescription
            draft = savedDraft
            pending = savedPending
        }
    }
}

extension ComposerView where Accessory == EmptyView {
    init(
        placeholder: String,
        onSend: @escaping (_ body: String, _ attachmentIds: [String]) async throws -> Void
    ) {
        self.init(placeholder: placeholder, onSend: onSend, accessory: { EmptyView() })
    }
}
