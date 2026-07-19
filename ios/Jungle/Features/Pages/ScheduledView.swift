import SwiftUI

// Scheduled agent turns — the port of Scheduled.tsx. Lists the workspace's schedules with
// pause/resume/delete; refetches on schedule_changed (coarse by design).
struct ScheduledView: View {
    @Environment(AppStore.self) private var store

    @State private var schedules: [Schedule] = []
    @State private var loaded = false

    var body: some View {
        List {
            if schedules.isEmpty && loaded {
                ContentUnavailableView(
                    "No schedules",
                    systemImage: "calendar.badge.clock",
                    description: Text("Agents (or you) can schedule recurring or one-shot runs."))
            }
            ForEach(schedules) { schedule in
                ScheduleRow(schedule: schedule, onChange: { await load() })
            }
        }
        .navigationTitle("Scheduled")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        schedules = (try? await store.api.listSchedules()) ?? []
        loaded = true
    }
}

private struct ScheduleRow: View {
    @Environment(AppStore.self) private var store
    let schedule: Schedule
    let onChange: () async -> Void

    @State private var busy = false

    private var paused: Bool { schedule.pausedAt != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(schedule.prompt)
                .font(.callout)
                .lineLimit(3)
            HStack(spacing: 6) {
                Text("@\(schedule.agentHandle ?? "agent")")
                Text("·")
                Text(cadence)
                if paused {
                    Text("· paused").foregroundStyle(.orange)
                }
                if schedule.lastStatus == "failure" {
                    Text("· \(schedule.failureCount) failure\(schedule.failureCount == 1 ? "" : "s")")
                        .foregroundStyle(.red)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let next = schedule.nextRunAt, !paused {
                Text("Next: \(Self.friendlyDate(next))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task {
                    try? await store.api.deleteSchedule(id: schedule.id)
                    await onChange()
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                Task {
                    _ = try? await store.api.updateSchedule(id: schedule.id, paused: !paused)
                    await onChange()
                }
            } label: {
                Label(paused ? "Resume" : "Pause", systemImage: paused ? "play" : "pause")
            }
            .tint(.orange)
        }
    }

    // The web uses cronstrue; a compact native fallback: show recognizable cadences, else the
    // raw cron with the timezone.
    private var cadence: String {
        if let runAt = schedule.runAt {
            return "once at \(Self.friendlyDate(runAt))"
        }
        guard let cron = schedule.cron else { return "—" }
        let described = Self.describeCron(cron)
        if let tz = schedule.timezone, tz != TimeZone.current.identifier {
            return "\(described) (\(tz))"
        }
        return described
    }

    static func describeCron(_ cron: String) -> String {
        let parts = cron.split(separator: " ").map(String.init)
        guard parts.count == 5 else { return cron }
        let (min, hour, dom, _, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4])
        let days = ["0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
                    "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday"]
        if let m = Int(min), let h = Int(hour) {
            let time = String(format: "%d:%02d", h == 0 ? 12 : (h > 12 ? h - 12 : h), m) + (h < 12 ? " AM" : " PM")
            if dom == "*" && dow == "*" { return "daily at \(time)" }
            if dom == "*", let day = days[dow] { return "every \(day) at \(time)" }
            if dow == "*", Int(dom) != nil { return "monthly on day \(dom) at \(time)" }
        }
        if min.hasPrefix("*/"), hour == "*" { return "every \(min.dropFirst(2)) min" }
        return cron
    }

    static func friendlyDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
