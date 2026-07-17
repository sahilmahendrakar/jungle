import Foundation

// Mints the bearer for authed requests — the native counterpart of api.ts's tokenGetter.
// The Firebase implementation (M1) wraps getIDToken(), which returns the cached token while
// valid and transparently refreshes near expiry; never cache a token string yourself.
protocol AuthTokenProvider: Sendable {
    func idToken(forceRefresh: Bool) async throws -> String?
}

extension AuthTokenProvider {
    func idToken() async throws -> String? {
        try await idToken(forceRefresh: false)
    }
}

// Dev bypass: no Firebase; the backend (running without FIREBASE_SERVICE_ACCOUNT) trusts
// ?participantId= instead. Mirrors the web's ?as= dev path.
struct DevBypassAuth: AuthTokenProvider {
    func idToken(forceRefresh: Bool) async throws -> String? { nil }
}
