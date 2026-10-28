import UserNotifications

/*
 * Every push arrives as a placeholder ("Something new from your bots") with
 * the notice sealed beside it; this opens it with the phone's key and shows
 * what it says. Neither the relay nor Firebase nor Apple can read it. A notice
 * this phone can't open still shows the placeholder.
 */
final class NotificationService: UNNotificationServiceExtension {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        self.content = content
        deliver = contentHandler
        if let sealed = request.content.userInfo["d"] as? String, let device = PushKeys.load(),
           let json = PushCrypto.open(key: device.seal, sealed: sealed), let notice = PhoneNotice(json: json), notice.withdraw == nil {
            content.title = notice.title.isEmpty ? "Gond" : notice.title
            content.body = notice.body
            content.threadIdentifier = notice.tag
            var info: [AnyHashable: Any] = ["url": notice.url, "tag": notice.tag]
            if let card = notice.card {
                // iOS names a notification's buttons by its category, set up once by the app: Allow and Deny.
                content.categoryIdentifier = PushCategory.card
                info["approval"] = card.id
            }
            content.userInfo = info
        }
        contentHandler(content)
        deliver = nil
    }

    override func serviceExtensionTimeWillExpire() {
        if let deliver, let content { deliver(content) }
        deliver = nil
    }
}
