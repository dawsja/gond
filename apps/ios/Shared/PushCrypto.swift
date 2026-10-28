import CryptoKit
import Foundation

/*
 * The phone's half of `apps/api/src/phone-push.ts`, as in the Android app's
 * PushCrypto.kt: a notice comes sealed with AES-256-GCM under the phone's own
 * key (twelve bytes of nonce, then the ciphertext and its tag, which is what
 * CryptoKit calls combined), and an answer to a card is signed with
 * HMAC-SHA256 under its answer key.
 */
enum PushCrypto {
    static func bytes(_ base64url: String) -> Data? {
        var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        return Data(base64Encoded: text)
    }

    /// The notice's JSON, or nil when it wasn't sealed for this key.
    static func open(key: String, sealed: String) -> String? {
        guard let key = bytes(key), let raw = bytes(sealed), raw.count >= 12 + 16,
              let box = try? AES.GCM.SealedBox(combined: raw),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key)) else { return nil }
        return String(data: plain, encoding: .utf8)
    }

    static func sign(key: String, device: String, at: String, approvalId: String, decision: String) -> String {
        let message = Data([device, at, approvalId, decision].joined(separator: "\n").utf8)
        let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: bytes(key) ?? Data()))
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}

/// What a sealed notice says (`PhoneNotice` in the API): one to show, or one to take back.
struct PhoneNotice {
    struct Card { let id: String; let allow: String; let deny: String }

    let title: String
    let body: String
    let url: String
    let tag: String
    let card: Card?
    /// The tag of a notice to take away, for a card answered elsewhere.
    let withdraw: String?

    init?(json: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return nil }
        withdraw = (object["withdraw"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        title = object["title"] as? String ?? ""
        body = object["body"] as? String ?? ""
        // Only a path on the person's own Gond opens; anything else opens the app.
        let url = object["url"] as? String ?? ""
        self.url = url.hasPrefix("/") && !url.hasPrefix("//") ? url : "/app"
        tag = (object["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? self.url
        if let card = object["card"] as? [String: Any], let id = card["id"] as? String, !id.isEmpty {
            self.card = Card(id: id, allow: card["allow"] as? String ?? "Allow", deny: card["deny"] as? String ?? "Deny")
        } else {
            card = nil
        }
    }
}

/// The category whose notifications carry Allow and Deny (`Notifications.swift` sets it up).
enum PushCategory {
    static let card = "gond.card"
    static let allow = "allow"
    static let deny = "deny"
}
