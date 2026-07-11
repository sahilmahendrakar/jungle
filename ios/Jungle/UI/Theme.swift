import SwiftUI
import UIKit

// Jungle design tokens — the native mirror of frontend/src/index.css ("deep jungle"
// identity: warm greenish neutrals + jade primary; green-tinted charcoal in dark mode; the
// sidebar is deep forest green in BOTH themes, matching the app icon #04271a family).
// Values are the oklch tokens converted to sRGB. A PR touching index.css's tokens should
// touch this file.

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }

    // One color per appearance, tracking the system theme like the web's .dark variant.
    static func jungle(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        })
    }
}

enum JungleTheme {
    // Main app surface
    static let background = Color.jungle(light: 0xF9FBF9, dark: 0x0D1914)
    static let foreground = Color.jungle(light: 0x121B17, dark: 0xE2EAE5)
    static let card = Color.jungle(light: 0xFFFFFF, dark: 0x15231D)

    // Jade primary
    static let primary = Color.jungle(light: 0x007756, dark: 0x3CC292)
    static let primaryForeground = Color.jungle(light: 0xF9FDFB, dark: 0x00140C)
    static let secondary = Color.jungle(light: 0xF1F4F2, dark: 0x202C26)
    static let muted = Color.jungle(light: 0xF0F3F1, dark: 0x1E2924)
    static let mutedForeground = Color.jungle(light: 0x5B6760, dark: 0x8C9991)
    static let accent = Color.jungle(light: 0xE3F1E9, dark: 0x22352C)
    static let accentForeground = Color.jungle(light: 0x033727, dark: 0xE9F1EC)
    static let destructive = Color.jungle(light: 0xE3121E, dark: 0xF14D4C)
    static let border = Color.jungle(light: 0xDFE4E1, dark: 0x27342E)

    // Sidebar — always-dark forest green (a step darker than the canvas in dark mode)
    static let sidebar = Color.jungle(light: 0x012619, dark: 0x01130B)
    static let sidebarForeground = Color.jungle(light: 0xDEE7E2, dark: 0xD8E1DB)
    static let sidebarPrimary = Color.jungle(light: 0x2AB186, dark: 0x3CC292)
    static let sidebarPrimaryForeground = Color.jungle(light: 0x010F08, dark: 0x00140C)
    static let sidebarAccent = Color.jungle(light: 0x123C2B, dark: 0x0C281C)
    static let sidebarAccentForeground = Color.jungle(light: 0xF2FBF6, dark: 0xF2FBF6)
    static let sidebarBorder = Color.jungle(light: 0x143829, dark: 0x0D241B)

    // Agent status dot colors (working rides the jade identity).
    static func statusColor(_ status: AgentStatus) -> Color {
        switch status {
        case .working: return primary
        case .idle: return Color.jungle(light: 0x0EA5E9, dark: 0x38BDF8) // sky
        case .waking: return Color.jungle(light: 0xF59E0B, dark: 0xFBBF24) // amber
        case .sleeping: return mutedForeground
        case .offline, .unknown: return mutedForeground.opacity(0.5)
        }
    }
}

// Deterministic avatar styling derived from a handle — a verbatim port of
// frontend/src/lib/people.ts: the same 10-color palette (Tailwind 500s), the same
// 32-bit `h*31+code` hash, so a given person gets the SAME color on web and iOS.
enum JungleAvatar {
    static let palette: [Color] = [
        Color(hex: 0xF43F5E), // rose-500
        Color(hex: 0xF97316), // orange-500
        Color(hex: 0xF59E0B), // amber-500
        Color(hex: 0x10B981), // emerald-500
        Color(hex: 0x14B8A6), // teal-500
        Color(hex: 0x0EA5E9), // sky-500
        Color(hex: 0x6366F1), // indigo-500
        Color(hex: 0x8B5CF6), // violet-500
        Color(hex: 0xD946EF), // fuchsia-500
        Color(hex: 0xEC4899), // pink-500
    ]

    static func color(for handle: String) -> Color {
        // JS: h = (h * 31 + charCode) | 0 — 32-bit signed overflow, then abs.
        var h: Int32 = 0
        for unit in handle.utf16 {
            h = h &* 31 &+ Int32(unit)
        }
        let index = Int(h.magnitude) % palette.count
        return palette[index]
    }

    // "Sahil Mahendrakar" -> "SM"; "sahils-agent" -> "SA"; single word -> first two letters.
    static func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace || $0 == "_" || $0 == "-" })
        guard let first = parts.first else { return "?" }
        if parts.count == 1 {
            return first.prefix(2).uppercased()
        }
        return (String(first.prefix(1)) + String(parts.last!.prefix(1))).uppercased()
    }
}

// The shared avatar tile — the PersonAvatar from panels.tsx: colored-initials fallback,
// deterministic per handle, white text, rounded-rect.
struct AvatarView: View {
    let name: String
    let handle: String
    var size: CGFloat = 36

    init(name: String? = nil, handle: String, size: CGFloat = 36) {
        self.name = name ?? handle
        self.handle = handle
        self.size = size
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(JungleAvatar.color(for: handle))
            Text(JungleAvatar.initials(name))
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}
