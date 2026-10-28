import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

/*
 * This iPhone's push: its Firebase token, and the id and keys the person's
 * Gond gave it when the web app signed it up (`setPushDevice` on the bridge).
 * A build without GoogleService-Info.plist never gets a token, and the web
 * app keeps showing notices itself while the app runs.
 */
@MainActor
final class Push: NSObject {
    static let shared = Push()

    private static let tokenKey = "push_token"
    /// The token or the device changed: the page reads the state again and signs up with it.
    var onChange: (() -> Void)?
    private(set) var token: String? = UserDefaults.standard.string(forKey: Push.tokenKey)

    func start() {
        guard FirebaseApp.app() == nil, Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else { return }
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        UIApplication.shared.registerForRemoteNotifications()
    }

    func registered(deviceToken: Data) {
        guard FirebaseApp.app() != nil else { return }
        Messaging.messaging().apnsToken = deviceToken
    }

    /// What the web app reads to sign this phone up: `{ token, device }`, each null until there is one.
    var state: String {
        let object: [String: Any] = ["token": token ?? NSNull(), "device": PushKeys.load()?.id ?? NSNull()]
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// The server's answer to signing up (`{ id, seal, answer }`), or nothing to sign this phone out.
    func save(_ json: String) {
        if json.isEmpty {
            PushKeys.save(nil)
        } else if let device = try? JSONDecoder().decode(PushKeys.Device.self, from: Data(json.utf8)) {
            PushKeys.save(device)
        }
        onChange?()
    }

    /// A quiet push: what it carries changes what's already shown, a card answered elsewhere.
    func received(_ userInfo: [AnyHashable: Any]) async {
        guard let sealed = userInfo["d"] as? String, let device = PushKeys.load(),
              let json = PushCrypto.open(key: device.seal, sealed: sealed), let notice = PhoneNotice(json: json), let tag = notice.withdraw else { return }
        let center = UNUserNotificationCenter.current()
        let shown = await center.deliveredNotifications()
        // APNs names a notification after its collapse id, which is the tag; the extension also keeps it.
        let gone = shown.filter { $0.request.identifier == tag || $0.request.content.userInfo["tag"] as? String == tag }.map(\.request.identifier)
        center.removeDeliveredNotifications(withIdentifiers: gone)
    }

    /// Allow or Deny on a card's notification, sent straight to the person's Gond and signed with this phone's answer key.
    /// Nil when the card took it; otherwise what to tell the person.
    func answer(approval: String, decision: String) async -> String? {
        guard let server = Prefs.server, let device = PushKeys.load(), let url = URL(string: "\(server)/api/push/answer") else { return "Open Gond to answer the card." }
        let at = String(Int(Date().timeIntervalSince1970 * 1000))
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(device.id, forHTTPHeaderField: "X-Gond-Device")
        request.setValue(at, forHTTPHeaderField: "X-Gond-Time")
        request.setValue(PushCrypto.sign(key: device.answer, device: device.id, at: at, approvalId: approval, decision: decision), forHTTPHeaderField: "X-Gond-Signature")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["approvalId": approval, "decision": decision])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) { return nil }
            // The server's words are written for the person ("That card was already answered or ran out of time").
            let said = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            return said?.isEmpty == false ? said : "Open Gond to answer the card."
        } catch {
            return "Gond didn't answer. Open the app to answer the card."
        }
    }
}

extension Push: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in
            guard let fcmToken, !fcmToken.isEmpty, fcmToken != self.token else { return }
            self.token = fcmToken
            UserDefaults.standard.set(fcmToken, forKey: Push.tokenKey)
            self.onChange?()
        }
    }
}

/// Push needs the app delegate's callbacks, which a SwiftUI app gets through this.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { Push.shared.start() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { Push.shared.registered(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        await Push.shared.received(userInfo)
        return .newData
    }
}
