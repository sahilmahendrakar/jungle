import SwiftUI

// Self-hosted runner machines — the port of Environments.tsx. Devices are account-scoped;
// online dots flip live via device_status_changed (coarse refetch here).
struct EnvironmentsView: View {
    @Environment(AppStore.self) private var store

    @State private var devices: [RunnerHost] = []
    @State private var loaded = false

    var body: some View {
        List {
            if devices.isEmpty && loaded {
                ContentUnavailableView(
                    "No devices",
                    systemImage: "desktopcomputer",
                    description: Text("Run `npx jungle-agents connect` on a machine, then approve it under Link device."))
            }
            ForEach(devices) { device in
                DeviceRow(device: device, onChange: { await load() })
            }
            Section {
                NavigationLink("Link a device") {
                    LinkDeviceView()
                }
            }
        }
        .navigationTitle("Environments")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        devices = (try? await store.api.listDevices()) ?? []
        loaded = true
    }
}

private struct DeviceRow: View {
    @Environment(AppStore.self) private var store
    let device: RunnerHost
    let onChange: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(device.online ? Color.green : Color.gray.opacity(0.5))
                    .frame(width: 8, height: 8)
                Text(device.name).font(.body.weight(.medium))
                Spacer()
                if device.runningAgents > 0 {
                    Text("\(device.runningAgents) running")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }
            Text(details)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task {
                    try? await store.api.removeDevice(id: device.id)
                    await onChange()
                }
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    private var details: String {
        var parts: [String] = []
        if let platform = device.platform { parts.append(platform) }
        if let arch = device.arch { parts.append(arch) }
        if let version = device.runnerVersion { parts.append("v\(version)") }
        parts.append(device.sandboxed ? "sandboxed" : "unsandboxed")
        return parts.joined(separator: " · ")
    }
}

// Approve a device code shown by `jungle-agents connect` — the port of LinkDevice.tsx.
struct LinkDeviceView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var code = ""
    @State private var busy = false
    @State private var message: String?
    @State private var succeeded = false

    var body: some View {
        Form {
            Section {
                Text("Run `npx jungle-agents connect` on the machine, then enter the code it shows.")
                    .font(.callout)
                TextField("device code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(.title3.monospaced())
            }
            if let message {
                Section {
                    Text(message).foregroundStyle(succeeded ? Color.green : Color.red)
                }
            }
            Section {
                Button {
                    Task { await approve() }
                } label: {
                    if busy { ProgressView() } else { Text("Approve device") }
                }
                .disabled(busy || code.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .navigationTitle("Link device")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func approve() async {
        busy = true
        message = nil
        defer { busy = false }
        let userCode = code.trimmingCharacters(in: .whitespaces)
        do {
            guard try await store.api.checkDeviceCode(userCode) else {
                message = "That code isn't valid anymore — generate a new one on the device."
                succeeded = false
                return
            }
            try await store.api.approveDeviceCode(userCode)
            message = "Device linked! It will appear in Environments once it connects."
            succeeded = true
            code = ""
        } catch {
            message = error.localizedDescription
            succeeded = false
        }
    }
}
