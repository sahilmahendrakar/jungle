import SwiftUI
import FirebaseCore
import GoogleSignIn

@main
struct JungleApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var sessionStore: SessionStore

    init() {
        // Configure Firebase only when the config ships in the bundle — a build without
        // GoogleService-Info.plist still runs in dev-bypass mode.
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            if let clientID = FirebaseApp.app()?.options.clientID {
                GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            }
        }
        _sessionStore = State(initialValue: SessionStore())
        PushManager.shared.configureCategories()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(sessionStore)
                .onOpenURL { url in
                    // Google sign-in redirect (reversed-client-id scheme).
                    GIDSignIn.sharedInstance.handle(url)
                }
        }
    }
}

// Decides what to show at the top level — the native counterpart of AuthGate.tsx.
struct RootView: View {
    @Environment(SessionStore.self) private var sessionStore

    var body: some View {
        switch sessionStore.phase {
        case .loading:
            ProgressView()
        case .signedOut:
            LandingView()
        case .onboarding(let me):
            OnboardingView(me: me)
        case .ready:
            if let session = sessionStore.session {
                SignedInShell()
                    .id("\(session.participantId):\(session.workspaceId ?? "")")
            } else {
                LandingView()
            }
        }
    }
}
