import Foundation

// Hand-ported from shared/src/constants.ts — validation constants and the model catalog.
// A PR touching constants.ts should touch this file.

// Agent handles: 2–30 chars, lowercase/digits/_/-, no leading symbol.
let handlePattern = "^[a-z0-9][a-z0-9_-]{1,29}$"

func isValidHandle(_ handle: String) -> Bool {
    handle.range(of: handlePattern, options: .regularExpression) != nil
}

enum ModelProvider: String, Codable, Sendable {
    case anthropic
    case zai
}

struct ModelCatalogEntry: Identifiable, Hashable, Sendable {
    var id: String
    var label: String
    var hint: String
    var provider: ModelProvider
    var supportsEffort: Bool
    var contextWindow: Int
}

// Order defines the picker order; the first entry is the default for new agents.
let modelCatalog: [ModelCatalogEntry] = [
    .init(id: "claude-opus-4-8", label: "Opus 4.8", hint: "Most capable", provider: .anthropic, supportsEffort: true, contextWindow: 200_000),
    .init(id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced", provider: .anthropic, supportsEffort: true, contextWindow: 200_000),
    .init(id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest", provider: .anthropic, supportsEffort: false, contextWindow: 200_000),
    .init(id: "glm-5.2", label: "GLM 5.2", hint: "Open source · fast & cheap", provider: .zai, supportsEffort: false, contextWindow: 200_000),
]

func catalogEntry(model: String?) -> ModelCatalogEntry? {
    guard let model else { return nil }
    return modelCatalog.first { $0.id == model }
}

let sdkModes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]

let effortLevels = ["low", "medium", "high", "xhigh"]
let defaultEffort = "medium"

let personaMaxLength = 4000

// --- Schedules ---
let maxSchedulesPerAgent = 10
let minScheduleIntervalMinutes = 15
let scheduleMaxConsecutiveFailures = 3
let schedulePromptMaxLength = 4000

// --- Client-side limits mirrored from frontend/src/lib/chat.ts ---
let attachmentMaxBytes = 25 * 1024 * 1024
let attachmentsPerMessage = 10
