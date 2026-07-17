import Foundation
import Observation
import FirebaseAuth
import FirebaseCore
import GoogleSignIn

// Who is signed in, into which workspace, against which backend — the native counterpart of
// the web's AuthGate + api.ts module-level auth state. Everything downstream (APIClient,
// ChatSocket) is derived from this store's session value.

// One established session: how to authenticate and who we are.
struct Session: Sendable {
    var mode: Mode
    var participantId: String
    var workspaceId: String?

    enum Mode: Sendable {
        // Firebase Google sign-in (prod): bearer tokens + X-Workspace-Id.
        case firebase
        // Backend DEV_BYPASS: no token; ?participantId= names the identity+workspace. (Debug)
        case devBypass
    }
}

// What the top level should show — the AuthGate.tsx decision.
enum AuthPhase {
    case loading // resolving persisted state at launch
    case signedOut // Landing (Google button / dev sign-in)
    case onboarding(Me) // signed into Google, but no workspace membership yet
    case ready // session established
}

@MainActor
@Observable
final class SessionStore {
    var environment: BackendEnvironment {
        didSet { environment.persist() }
    }
    private(set) var phase: AuthPhase = .loading
    private(set) var session: Session?
    // The signed-in account's profile + memberships (Firebase mode; nil under dev bypass).
    private(set) var me: Me?

    // The API client for the current environment + session. Rebuilt on any auth change so
    // in-flight consumers keep a consistent snapshot.
    private(set) var api: APIClient

    var tokenProvider: AuthTokenProvider {
        session?.mode == .firebase ? FirebaseAuthProvider() : DevBypassAuth()
    }

    var firebaseAvailable: Bool { FirebaseApp.app() != nil }

    init() {
        let env = BackendEnvironment.loadPersisted()
        environment = env
        api = APIClient(environment: env, tokenProvider: DevBypassAuth())
        Task { await restoreAtLaunch() }
    }

    private func restoreAtLaunch() async {
        #if DEBUG
        if let saved = UserDefaults.standard.string(forKey: Self.devSessionKey) {
            api = APIClient(environment: environment, tokenProvider: DevBypassAuth(), devParticipantId: saved)
            session = Session(mode: .devBypass, participantId: saved, workspaceId: nil)
            phase = .ready
            return
        }
        #endif
        if firebaseAvailable, Auth.auth().currentUser != nil {
            await completeFirebaseSignIn()
        } else {
            phase = .signedOut
        }
    }

    // --- Firebase (Google) sign-in ---

    private static let workspaceKey = "activeWorkspaceId"

    // Native counterpart of GoogleSignIn.tsx's signInWithPopup: GoogleSignIn SDK -> Firebase
    // credential -> /api/me -> workspace pick or onboarding.
    func signInWithGoogle(presenting: UIViewController) async throws {
        guard firebaseAvailable else {
            throw APIError(message: "Firebase isn't configured in this build")
        }
        let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenting)
        guard let idToken = result.user.idToken?.tokenString else {
            throw APIError(message: "Google sign-in returned no token")
        }
        let credential = GoogleAuthProvider.credential(
            withIDToken: idToken,
            accessToken: result.user.accessToken.tokenString)
        try await Auth.auth().signIn(with: credential)
        await completeFirebaseSignIn()
    }

    // Resolve the signed-in account into a session: load memberships, pick the last-used
    // workspace (or the only one), or hand off to onboarding when there are none.
    func completeFirebaseSignIn() async {
        let client = APIClient(environment: environment, tokenProvider: FirebaseAuthProvider())
        do {
            let me = try await client.me()
            self.me = me
            guard !me.memberships.isEmpty else {
                phase = .onboarding(me)
                return
            }
            let savedWorkspace = UserDefaults.standard.string(forKey: Self.workspaceKey)
            let membership = me.memberships.first { $0.workspace.id == savedWorkspace }
                ?? me.memberships[0]
            activate(membership: membership)
        } catch {
            // Token invalid / backend unreachable: fall back to signed-out with the error
            // surfaced by the Landing screen on retry.
            phase = .signedOut
        }
    }

    // Enter a workspace (initial pick or switcher): scope the API client + session to it.
    func activate(membership: Membership) {
        let workspaceId = membership.workspace.id
        UserDefaults.standard.set(workspaceId, forKey: Self.workspaceKey)
        api = APIClient(
            environment: environment,
            tokenProvider: FirebaseAuthProvider(),
            workspaceId: workspaceId)
        session = Session(
            mode: .firebase,
            participantId: membership.participant.id,
            workspaceId: workspaceId)
        phase = .ready
    }

    // Onboarding: create a workspace and land in it.
    func createWorkspaceAndEnter(name: String, handle: String, displayName: String) async throws {
        let client = APIClient(environment: environment, tokenProvider: FirebaseAuthProvider())
        let created = try await client.createWorkspace(name: name, handle: handle, displayName: displayName)
        let membership = Membership(
            workspace: created.workspace,
            participant: created.participant,
            github: .init(connected: false, login: nil))
        me?.memberships.append(membership)
        activate(membership: membership)
    }

    // Onboarding: join via invite token and land in that workspace.
    func acceptInviteAndEnter(token: String, handle: String, displayName: String) async throws {
        let client = APIClient(environment: environment, tokenProvider: FirebaseAuthProvider())
        _ = try await client.acceptInvite(token: token, handle: handle, displayName: displayName)
        await completeFirebaseSignIn()
    }

    // --- Dev bypass (Debug builds, backend without Firebase auth) ---

    private static let devSessionKey = "devSessionParticipantId"

    // Validates the participant against the backend before committing the session, so a typo'd
    // id fails at sign-in rather than as a broken empty app.
    func signInDevBypass(participantId: String) async throws {
        let client = APIClient(
            environment: environment,
            tokenProvider: DevBypassAuth(),
            devParticipantId: participantId)
        let participants = try await client.listParticipants()
        guard participants.contains(where: { $0.id == participantId }) else {
            throw APIError(message: "no participant with id \(participantId)")
        }
        api = client
        session = Session(mode: .devBypass, participantId: participantId, workspaceId: nil)
        phase = .ready
        #if DEBUG
        UserDefaults.standard.set(participantId, forKey: Self.devSessionKey)
        #endif
    }

    func signOut() {
        if firebaseAvailable {
            try? Auth.auth().signOut()
            GIDSignIn.sharedInstance.signOut()
        }
        session = nil
        me = nil
        phase = .signedOut
        api = APIClient(environment: environment, tokenProvider: DevBypassAuth())
        #if DEBUG
        UserDefaults.standard.removeObject(forKey: Self.devSessionKey)
        #endif
    }

    // Change backend target (Debug): drops the session, since identities are per-backend.
    func switchEnvironment(_ env: BackendEnvironment) {
        environment = env
        signOut()
    }
}
