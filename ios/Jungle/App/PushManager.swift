import SwiftUI
import UserNotifications
import FirebaseCore
import FirebaseMessaging

// APNs/FCM wiring: permission + token registration with the backend, the CONFIRM category's
// Allow/Deny actions (resolved directly from the notification, no app UI), and deep-link
// routing for notification taps. Active only in Firebase mode (dev bypass has no push).
@MainActor
final class PushManager: NSObject, ObservableObject {
    static let shared = PushManager()

    // Where a notification tap should land; observed by the shell.
    enum DeepLink: Equatable {
        case channel(id: String, threadRootId: String?)
        case approvals
    }

    @Published var deepLink: DeepLink?

    // Set by the shell when a session is live, so token registration and confirm actions can
    // reach the right backend with the right auth.
    var api: APIClient?

    static let confirmCategoryId = "CONFIRM"
    static let allowActionId = "CONFIRM_ALLOW"
    static let denyActionId = "CONFIRM_DENY"

    func configureCategories() {
        let allow = UNNotificationAction(
            identifier: Self.allowActionId, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: Self.denyActionId, title: "Deny", options: [.destructive, .authenticationRequired])
        let confirm = UNNotificationCategory(
            identifier: Self.confirmCategoryId, actions: [allow, deny], intentIdentifiers: [])
        UNUserNotificationCenter.current().setNotificationCategories([confirm])
        UNUserNotificationCenter.current().delegate = self
    }

    // Ask for permission and register with APNs; the FCM token lands in the Messaging delegate.
    func enablePush() async {
        guard FirebaseApp.app() != nil else { return }
        Messaging.messaging().delegate = self
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
        // The token may already exist from a previous launch.
        if let token = Messaging.messaging().fcmToken {
            await register(token: token)
        }
    }

    func unregisterCurrentToken() async {
        guard FirebaseApp.app() != nil, let token = Messaging.messaging().fcmToken else { return }
        try? await api?.unregisterPushToken(token)
    }

    private func register(token: String) async {
        try? await api?.registerPushToken(token)
    }

    fileprivate func handle(userInfo: [AnyHashable: Any], action: String?) async {
        let kind = userInfo["kind"] as? String
        let confirmId = userInfo["confirmId"] as? String

        // Allow/Deny straight from the notification. A 404 means it already resolved or hit
        // the server's auto-deny timeout — nothing to do.
        if let action, let confirmId {
            let decision = action == Self.allowActionId ? "allow" : "deny"
            try? await api?.confirmToolCall(confirmId: confirmId, decision: decision)
            return
        }

        // Body tap: route into the app.
        if kind == "confirm" {
            deepLink = .approvals
        } else if let channelId = userInfo["channelId"] as? String {
            deepLink = .channel(id: channelId, threadRootId: userInfo["threadRootId"] as? String)
        }
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    // Foregrounded app: the in-app UI already carries the signal; show nothing.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let action = response.actionIdentifier == UNNotificationDefaultActionIdentifier
            ? nil : response.actionIdentifier
        await handle(userInfo: userInfo, action: action)
    }
}

extension PushManager: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor in
            await self.register(token: fcmToken)
        }
    }
}

// UIKit app delegate: forwards the APNs device token to FCM.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Messaging.messaging().apnsToken = deviceToken
    }
}

extension APIClient {
    func registerPushToken(_ token: String) async throws {
        struct Body: Encodable {
            var token: String
            var platform = "ios"
        }
        try await requestVoid(
            "/api/push/register",
            .init(jsonBody: Body(token: token), devAuth: false, errorMessage: "failed to register for push"))
    }

    func unregisterPushToken(_ token: String) async throws {
        struct Body: Encodable {
            var token: String
        }
        try await requestVoid(
            "/api/push/register",
            .init(method: "DELETE", jsonBody: Body(token: token), devAuth: false,
                  errorMessage: "failed to unregister push"))
    }
}
