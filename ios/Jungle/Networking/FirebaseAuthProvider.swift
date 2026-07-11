import Foundation
import FirebaseAuth

// Bearer tokens from FirebaseAuth — the native tokenGetter. getIDToken returns the cached
// token while valid and transparently refreshes near expiry, so this is always fresh and
// never needs app-side caching.
struct FirebaseAuthProvider: AuthTokenProvider {
    func idToken(forceRefresh: Bool) async throws -> String? {
        guard let user = Auth.auth().currentUser else { return nil }
        return try await user.getIDToken(forcingRefresh: forceRefresh)
    }
}
