import Foundation

// Which backend the app talks to — the native counterpart of the web's VITE_API_URL/VITE_WS_URL.
// Release builds are locked to Prod; Debug builds can point at a Mac on the LAN running
// `npm run dev` (http://<mac-ip>:3001), with the host editable in the dev sign-in screen.
enum BackendEnvironment: Codable, Hashable, Sendable {
    case prod
    case lan(host: String)

    static let prodAPIBase = URL(string: "https://api.jungleagents.com")!

    var apiBase: URL {
        switch self {
        case .prod:
            return Self.prodAPIBase
        case .lan(let host):
            return URL(string: "http://\(host):3001") ?? Self.prodAPIBase
        }
    }

    // ws(s):// origin derived from the API origin, like the web derives WS_BASE.
    var wsBase: URL {
        var components = URLComponents(url: apiBase, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }

    var label: String {
        switch self {
        case .prod: return "Production"
        case .lan(let host): return "LAN (\(host))"
        }
    }
}

extension BackendEnvironment {
    private static let defaultsKey = "backendEnvironment"

    static func loadPersisted() -> BackendEnvironment {
        #if DEBUG
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let env = try? JSONDecoder().decode(BackendEnvironment.self, from: data)
        else { return .prod }
        return env
        #else
        return .prod
        #endif
    }

    func persist() {
        #if DEBUG
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
        #endif
    }
}
