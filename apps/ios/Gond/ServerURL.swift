import Foundation

/*
 * The same rules as the desktop app's server-url crate and the Android
 * app's ServerUrl.kt: Gond serves the web app and /api from one origin, so
 * the path is dropped; without a scheme, https is tried first, except for
 * this machine and private networks, where a plain-http install is the norm.
 */
enum ServerURL {
    enum Invalid: Error, Equatable {
        case empty, invalid, scheme, credentials
    }

    private static let localHost = #"^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.local|[^.]+)$"#
    private static let hasScheme = #"^[a-z][a-z\d+.-]*://"#

    static func candidates(_ input: String?) throws -> [String] {
        let raw = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { throw Invalid.empty }
        let urls: [String]
        if matches(raw, hasScheme) {
            urls = [raw]
        } else {
            let host = raw.split(omittingEmptySubsequences: false, whereSeparator: { "/:?#".contains($0) }).first.map(String.init) ?? ""
            urls = matches(host, localHost) ? ["http://\(raw)", "https://\(raw)"] : ["https://\(raw)", "http://\(raw)"]
        }
        return try urls.map { value in
            guard let parts = URLComponents(string: value) else { throw Invalid.invalid }
            let scheme = parts.scheme?.lowercased()
            if scheme != "http" && scheme != "https" { throw Invalid.scheme }
            if parts.user != nil || parts.password != nil { throw Invalid.credentials }
            guard let origin = origin(of: parts) else { throw Invalid.invalid }
            return origin
        }
    }

    static func origin(_ url: String?) -> String? {
        guard let url, let parts = URLComponents(string: url) else { return nil }
        return origin(of: parts)
    }

    static func origin(_ url: URL?) -> String? {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return origin(of: parts)
    }

    static func origin(scheme: String, host: String, port: Int?) -> String? {
        let scheme = scheme.lowercased()
        guard scheme == "http" || scheme == "https", !host.isEmpty else { return nil }
        let name = host.lowercased()
        let bracketed = name.contains(":") && !name.hasPrefix("[") ? "[\(name)]" : name
        let standard = scheme == "https" ? 443 : 80
        let suffix = port.map { $0 == standard || $0 == 0 ? "" : ":\($0)" } ?? ""
        return "\(scheme)://\(bracketed)\(suffix)"
    }

    static func sameOrigin(_ url: String?, _ origin: String?) -> Bool {
        guard let origin, let mine = self.origin(url) else { return false }
        return mine == origin
    }

    static func sameOrigin(_ url: URL?, _ origin: String?) -> Bool {
        guard let origin, let mine = self.origin(url) else { return false }
        return mine == origin
    }

    private static func origin(of parts: URLComponents) -> String? {
        guard let scheme = parts.scheme, let host = parts.host else { return nil }
        return origin(scheme: scheme, host: host, port: parts.port)
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
