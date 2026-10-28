import Foundation
import Security

/*
 * The id and keys this iPhone's Gond gave it for push, in the keychain shared
 * by the app and its notification service extension through the App Group,
 * readable once the phone has been unlocked since it started, since notices
 * arrive while it's locked. Never in a backup, never on another phone.
 */
enum PushKeys {
    static let group = "group.io.gond.ios"
    private static let account = "push-device"

    struct Device: Codable { let id: String; let seal: String; let answer: String }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.gond.ios.push", kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
    }

    static func load() -> Device? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Device.self, from: data)
    }

    static func save(_ device: Device?) {
        SecItemDelete(query as CFDictionary)
        guard let device, let data = try? JSONEncoder().encode(device) else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
