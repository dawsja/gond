import SwiftUI
import UIKit

enum Prefs {
    private static let serverKey = "server"

    static var server: String? {
        get { UserDefaults.standard.string(forKey: serverKey) }
        set { UserDefaults.standard.set(newValue, forKey: serverKey) }
    }
}

enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum Screen { case connect, web }

    @Published private(set) var server: String?
    @Published var screen: Screen
    @Published var address: String
    @Published var connectError: String?
    @Published private(set) var connecting = false
    /// What the page says it is drawn in (`setTheme`), so the window around it and the status bar match; nil on Connect.
    @Published private(set) var pageBackground: Color?
    @Published private(set) var pageDark: Bool?
    /// The page follows the system, so the app mustn't pin a scheme: the web view would then only ever see that one.
    @Published private(set) var pageFollowsSystem = false
    @Published var progress: Double = 1

    let ui = NativeUI()
    private(set) lazy var shell = WebShell(model: self)
    private let signIn = SignIn()

    init() {
        #if DEBUG
        // The screenshot job (.github/workflows/ios-screens.yml) points a debug build at a seeded Gond.
        if let server = ProcessInfo.processInfo.environment["GOND_SCREENS_SERVER"] { Prefs.server = server }
        #endif
        let saved = Prefs.server
        server = saved
        address = saved ?? ""
        screen = saved == nil ? .connect : .web
    }

    func start() {
        Notifications.shared.onOpen = { [weak self] url in self?.open(url) }
        // A tap on a notification that launched the app opens its conversation, not the list.
        let target = Notifications.shared.takePendingOpen() ?? "/app"
        #if DEBUG
        let screens = ProcessInfo.processInfo.environment
        if let server, let cookie = screens["GOND_SCREENS_COOKIE"], let path = screens["GOND_SCREENS_PATH"] {
            Task {
                await shell.setCookie(cookie, for: server)
                open(path)
            }
            return
        }
        #endif
        if server != nil { open(target) }
    }

    /// Connect can go back to the Gond it came from when one is loaded.
    var canGoBack: Bool { server != nil && shell.hasPage }

    func showConnect(error: String? = nil) {
        resetTheme()
        ui.clear()
        if let server { address = server }
        connectError = error
        screen = .connect
    }

    func backToServer() {
        guard server != nil else { return }
        connectError = nil
        screen = .web
    }

    func connect() async {
        guard !connecting else { return }
        let origins: [String]
        do {
            origins = try ServerURL.candidates(address)
        } catch let failure as ServerURL.Invalid {
            connectError = Self.message(for: failure)
            return
        } catch {
            connectError = "Something went wrong. Try again."
            return
        }
        connecting = true
        connectError = nil
        var found: String?
        for origin in origins {
            if await Self.isGond(origin) {
                found = origin
                break
            }
        }
        connecting = false
        guard let found else {
            connectError = "No Gond answered at that address. Check it, and that Gond is running."
            return
        }
        // A different Gond: its own sign-in, not the last one's, and its own push keys.
        if found != server {
            await shell.forgetEverything()
            PushKeys.save(nil)
        }
        server = found
        Prefs.server = found
        open("/login")
    }

    /// A path on the connected Gond, like /app/t/…, or a whole address there.
    func open(_ target: String) {
        guard let server else { return }
        let path: String
        if target.hasPrefix("/") && !target.hasPrefix("//") {
            path = target
        } else if ServerURL.sameOrigin(target, server), let url = URL(string: target) {
            path = url.path.isEmpty ? "/app" : url.path + (url.query.map { "?\($0)" } ?? "")
        } else {
            path = "/app"
        }
        screen = .web
        shell.load(server: server, path: path)
    }

    func startSignIn(next: String?) {
        guard let server else { return }
        signIn.start(server: server, next: next) { [weak self] path in self?.open(path) }
    }

    func applyTheme(background: String?, dark: Bool, system: Bool) {
        if let background, let color = UIColor(css: background) { pageBackground = Color(color) }
        pageDark = dark
        pageFollowsSystem = system
    }

    private func resetTheme() {
        pageBackground = nil
        pageDark = nil
        pageFollowsSystem = false
    }

    private static func message(for failure: ServerURL.Invalid) -> String {
        switch failure {
        case .empty: return "Enter the address of your Gond."
        case .invalid: return "That doesn't look like an address. Try something like https://gond.example.com."
        case .scheme: return "The address has to start with http:// or https://."
        case .credentials: return "Leave the username and password out of the address."
        }
    }

    private static func isGond(_ origin: String) async -> Bool {
        guard let url = URL(string: "\(origin)/api/health") else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return false }
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return body?["ok"] as? Bool == true
        } catch {
            return false
        }
    }
}
