import SwiftUI

// Signed-out landing: Google sign-in (Firebase mode) and, in Debug builds, the dev-bypass
// path — the counterpart of Landing.tsx + GoogleSignIn.tsx.
struct LandingView: View {
    @Environment(SessionStore.self) private var sessionStore

    @State private var busy = false
    @State private var errorMessage: String?
    @State private var showDevSignIn = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "leaf.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)
            Text("Jungle")
                .font(.largeTitle.bold())
            Text("Chat with agents that do real work")
                .font(.headline)
                .foregroundStyle(.secondary)

            Spacer()

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Button {
                Task { await signIn() }
            } label: {
                HStack {
                    if busy {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "person.badge.key.fill")
                    }
                    Text("Continue with Google")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || !sessionStore.firebaseAvailable)
            .padding(.horizontal, 24)

            if !sessionStore.firebaseAvailable {
                Text("Google sign-in needs GoogleService-Info.plist in the app bundle.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            #if DEBUG
            Button("Developer sign-in") {
                showDevSignIn = true
            }
            .font(.footnote)
            #endif

            Spacer().frame(height: 32)
        }
        .sheet(isPresented: $showDevSignIn) {
            DevSignInView()
        }
    }

    private func signIn() async {
        guard let presenter = UIApplication.rootViewController else {
            errorMessage = "no presenting view controller"
            return
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await sessionStore.signInWithGoogle(presenting: presenter)
        } catch {
            // User-cancelled sign-in shouldn't read as an error.
            let ns = error as NSError
            if ns.domain != "com.google.GIDSignIn" || ns.code != -5 {
                errorMessage = error.localizedDescription
            }
        }
    }
}

extension UIApplication {
    // The foreground scene's presenting view controller, for GIDSignIn's UIKit entry point.
    static var rootViewController: UIViewController? {
        let scene = shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

// Create-a-workspace onboarding (invite links join via /join deep links, M4) — the
// counterpart of Onboarding.tsx's create path.
struct OnboardingView: View {
    @Environment(SessionStore.self) private var sessionStore
    let me: Me

    @State private var workspaceName = ""
    @State private var handle = ""
    @State private var inviteLink = ""
    @State private var busy = false
    @State private var errorMessage: String?

    // Accepts a full https://…/join/<token> link or a bare token.
    private var inviteToken: String {
        let trimmed = inviteLink.trimmingCharacters(in: .whitespaces)
        if let range = trimmed.range(of: "/join/") {
            return String(trimmed[range.upperBound...])
        }
        return trimmed.contains("/") ? "" : trimmed
    }

    private func join() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await sessionStore.acceptInviteAndEnter(
                token: inviteToken,
                handle: handle,
                displayName: me.profile.name ?? handle)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Welcome, \(me.profile.name ?? me.profile.email ?? "friend")! Create a workspace to get started.")
                        .font(.callout)
                }
                Section("Workspace") {
                    TextField("Workspace name", text: $workspaceName)
                }
                Section("Or join with an invite link") {
                    TextField("Paste invite link or token", text: $inviteLink)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !inviteToken.isEmpty {
                        Button {
                            Task { await join() }
                        } label: {
                            if busy { ProgressView() } else { Text("Join workspace") }
                        }
                        .disabled(busy || !isValidHandle(handle))
                    }
                }
                Section("Your handle") {
                    TextField("handle", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !handle.isEmpty && !isValidHandle(handle) {
                        Text("2–30 chars: lowercase letters, digits, _ or -, starting with a letter/digit.")
                            .font(.caption)
                            .foregroundStyle(.red)
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
                        if busy { ProgressView() } else { Text("Create workspace") }
                    }
                    .disabled(busy || workspaceName.isEmpty || !isValidHandle(handle))
                }
            }
            .navigationTitle("Set up Jungle")
            .toolbar {
                Button("Sign out") { sessionStore.signOut() }
            }
            .onAppear {
                if handle.isEmpty { handle = me.suggestedHandle }
            }
        }
    }

    private func create() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await sessionStore.createWorkspaceAndEnter(
                name: workspaceName.trimmingCharacters(in: .whitespaces),
                handle: handle,
                displayName: me.profile.name ?? handle)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
