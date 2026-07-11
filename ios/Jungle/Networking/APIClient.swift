import Foundation

// The one request path for every backend call — a faithful port of frontend/src/api.ts's
// request(): resolves the URL against the active environment, attaches auth (bearer when
// present; ?participantId= dev bypass when there isn't one and the endpoint allows it),
// sends the X-Workspace-Id header, and throws the server's { error } string on non-2xx.
// Endpoint functions live in APIClient+*.swift extensions, grouped as api.ts groups them.

struct APIError: LocalizedError {
    var message: String
    var status: Int?

    var errorDescription: String? { message }
    var isNotFound: Bool { status == 404 }
}

final class APIClient: Sendable {
    let environment: BackendEnvironment
    let tokenProvider: AuthTokenProvider
    // Dev/test identity: used only when there's no bearer token (backend DEV_BYPASS).
    let devParticipantId: String?
    // The active workspace (multi-tenancy): sent on every authed request. Nil in dev mode
    // (the participantId already names a workspace).
    let workspaceId: String?

    private let session: URLSession

    init(
        environment: BackendEnvironment,
        tokenProvider: AuthTokenProvider,
        devParticipantId: String? = nil,
        workspaceId: String? = nil
    ) {
        self.environment = environment
        self.tokenProvider = tokenProvider
        self.devParticipantId = devParticipantId
        self.workspaceId = workspaceId
        self.session = URLSession(configuration: .default)
    }

    struct RequestOptions {
        var method: String?
        var jsonBody: Encodable?
        var rawBody: Data?
        var contentType: String?
        var auth = true
        var devAuth = true
        var errorMessage = "request failed"
    }

    func requestData(_ path: String, _ opts: RequestOptions = .init()) async throws -> Data {
        var urlString = environment.apiBase.absoluteString + path
        var bearer: String? = nil
        if opts.auth {
            bearer = try? await tokenProvider.idToken()
        }
        // Dev bypass: append ?participantId= only when there's no token (mirrors buildUrl()).
        if opts.devAuth, bearer == nil, let devId = devParticipantId,
           let encoded = devId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            urlString += (urlString.contains("?") ? "&" : "?") + "participantId=\(encoded)"
        }
        guard let url = URL(string: urlString) else {
            throw APIError(message: "bad url: \(path)")
        }

        var request = URLRequest(url: url)
        if let bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let workspaceId {
            request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
        }
        if let json = opts.jsonBody {
            request.httpBody = try JSONEncoder().encode(json)
            request.setValue(opts.contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        } else if let raw = opts.rawBody {
            request.httpBody = raw
            request.setValue(opts.contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        request.httpMethod = opts.method ?? (request.httpBody != nil ? "POST" : "GET")

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let serverError = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(message: serverError ?? opts.errorMessage, status: status)
        }
        return data
    }

    func request<T: Decodable>(_ path: String, _ opts: RequestOptions = .init()) async throws -> T {
        let data = try await requestData(path, opts)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "failed to decode \(T.self) from \(path): \(error)")
        }
    }

    // Fire-and-check calls whose response body we don't need (e.g. mark-read).
    func requestVoid(_ path: String, _ opts: RequestOptions = .init()) async throws {
        _ = try await requestData(path, opts)
    }

    private struct ErrorBody: Decodable {
        var error: String?
    }
}

// Helper for percent-encoding query values (RFC 3986 unreserved set).
extension String {
    var queryEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~"))) ?? self
    }
}
