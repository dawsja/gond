import AppKit
import UserNotifications

/*
 * The web app asks for a notice through the bridge on the API's `notify` live event, which comes
 * while Gond is open, the window shown or not. There's no push to a Mac yet, so a Gond that isn't
 * running hears nothing.
 */
@MainActor
final class Notifications: NSObject {
    static let shared = Notifications()

    /// Where a clicked notification goes: a path on your Gond.
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
        case .authorized, .provisional: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    /// Asks the first time; after a no, only System Settings can change it, so that opens.
    func request() async {
        switch await state() {
        case "prompt":
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        case "denied":
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { _ = NSWorkspace.shared.open(url) }
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

    /// A click that launched the app arrives before the page is ready for it.
    func takePendingOpen() -> String? {
        defer { pendingOpen = nil }
        return pendingOpen
    }

    fileprivate func open(_ url: String) {
        NSApp.activate()
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
