import UIKit
import UserNotifications

/*
 * The web view has no Web Push, so the web app asks for a notification
 * through the bridge on the API's `notify` live event, as in the Android
 * app. iOS pauses the page soon after the app leaves the screen, so they
 * come while Gond is open or just put away.
 */
@MainActor
final class Notifications: NSObject {
    static let shared = Notifications()

    /// Where a tapped notification goes: a path on your Gond.
    var onOpen: ((String) -> Void)?
    private var pendingOpen: String?

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// "granted", "denied" or "prompt", as the web app's notifications card shows it.
    func state() async -> String {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    /// Asks the first time; after a no, iOS only lets the person change it in Settings, so that opens.
    func request() async {
        switch await state() {
        case "prompt":
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        case "denied":
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { _ = await UIApplication.shared.open(url) }
        default:
            break
        }
    }

    func show(title: String, body: String, url: String, tag: String) {
        Task {
            guard await state() == "granted" else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.threadIdentifier = tag
            content.userInfo = ["url": url]
            // One notification per conversation, the newest replacing the last.
            let request = UNNotificationRequest(identifier: tag.isEmpty ? UUID().uuidString : tag, content: content, trigger: nil)
            try? await UNUserNotificationCenter.current().add(request)
        }
    }

    /// A tap that launched the app arrives before the page is ready for it.
    func takePendingOpen() -> String? {
        defer { pendingOpen = nil }
        return pendingOpen
    }

    fileprivate func open(_ url: String) {
        if let onOpen { onOpen(url) } else { pendingOpen = url }
    }
}

extension Notifications: UNUserNotificationCenterDelegate {
    /// The API sends nothing about the conversation on screen, so whatever arrives while Gond is open is shown.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let url = response.notification.request.content.userInfo["url"] as? String ?? "/app"
        await MainActor.run { self.open(url) }
    }
}
