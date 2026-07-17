import SwiftUI

// Debug-only entry: pick the backend (Prod / LAN) and sign in with a raw participantId, the
// native counterpart of the web's dev SignIn.tsx (?as=). Release builds show a placeholder
// until Google sign-in lands in M1.
struct DevSignInView: View {
    @Environment(SessionStore.self) private var sessionStore

    @State private var lanHost = ""
    @State private var useLAN = false
    @State private var participantId = ""
    @State private var participants: [Participant] = []
    @State private var errorMessage: String?
    @State private var busy = false

    var body: some View {
        #if DEBUG
        NavigationStack {
            Form {
                Section("Backend") {
                    Toggle("Use LAN backend", isOn: $useLAN)
                    if useLAN {
                        TextField("Mac LAN IP (e.g. 192.168.1.20)", text: $lanHost)
                            .keyboardType(.decimalPad)
                            .autocorrectionDisabled()
                    }
                    Text(currentEnvironment.apiBase.absoluteString)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Sign in as") {
                    TextField("participantId", text: $participantId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                    Button("List participants") {
                        Task { await loadParticipants() }
                    }
                    ForEach(participants.filter { $0.kind == .human }) { p in
                        Button {
                            participantId = p.id
                        } label: {
                            VStack(alignment: .leading) {
                                Text("@\(p.handle)").font(.body.weight(.medium))
                                Text(p.id).font(.caption.monospaced()).foregroundStyle(.secondary)
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
                        Task { await signIn() }
                    } label: {
                        if busy {
                            ProgressView()
                        } else {
                            Text("Sign in")
                        }
                    }
                    .disabled(participantId.isEmpty || busy)
                }
            }
            .navigationTitle("Jungle Dev")
            .onAppear {
                if case .lan(let host) = sessionStore.environment {
                    useLAN = true
                    lanHost = host
                }
            }
        }
        #else
        ContentUnavailableView(
            "Sign in coming soon",
            systemImage: "leaf",
            description: Text("Google sign-in lands in the next milestone."))
        #endif
    }

    private var currentEnvironment: BackendEnvironment {
        useLAN && !lanHost.isEmpty ? .lan(host: lanHost) : .prod
    }

    private func applyEnvironment() {
        if sessionStore.environment != currentEnvironment {
            sessionStore.switchEnvironment(currentEnvironment)
        }
    }

    private func loadParticipants() async {
        applyEnvironment()
        errorMessage = nil
        do {
            // Listing needs an identity under DEV_BYPASS on some routes; the participants list
            // endpoint accepts anonymous reads in dev, so try plain first.
            participants = try await sessionStore.api.listParticipants()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func signIn() async {
        applyEnvironment()
        errorMessage = nil
        busy = true
        defer { busy = false }
        do {
            try await sessionStore.signInDevBypass(participantId: participantId.trimmingCharacters(in: .whitespaces))
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
