import AppKit
import os
import SwiftUI

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

#if DEBUG
/// The screenshot job (.github/workflows/mac-screens.yml) points a debug build at a seeded Gond.
enum Screens {
    private static var env: [String: String] { ProcessInfo.processInfo.environment }
    static var server: String? { env["GOND_SCREENS_SERVER"] }
    static var cookie: String? { env["GOND_SCREENS_COOKIE"] }
    static var path: String? { env["GOND_SCREENS_PATH"] }
    /// "light" or "dark", for the whole app.
    static var appearance: String? { env["GOND_SCREENS_APPEARANCE"] }
    static var connect: Bool { env["GOND_SCREENS_CONNECT"] == "1" }
    static var active: Bool { server != nil || connect }
    /// Where the job keeps its screenshots, which the app (not sandboxed, unlike the test runner) can write to.
    static var folder: URL? { env["GOND_SCREENS_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } }
    /// The step this launch is for, naming what the app writes there.
    static var label: String { env["GOND_SCREENS_LABEL"].flatMap { $0.isEmpty ? nil : $0 } ?? "app" }
    /// WebKit features to turn off, for a runner whose graphics WebKit can't use.
    static var webKitOff: [String] { (env["GOND_SCREENS_WEBKIT_OFF"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    private static let log = Logger(subsystem: "io.gond.mac", category: "screens")

    /// A line for the job: in the app's log and in `<label>-<appearance>.txt` beside the screenshots.
    static func note(_ line: String) {
        log.notice("\(label, privacy: .public): \(line, privacy: .public)")
        guard let folder else { return }
        let file = folder.appendingPathComponent("\(label)-\(appearance ?? "light").txt")
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: file)
        }
    }

    /// A picture for the job, beside the screenshots.
    static func save(_ image: NSImage, as name: String) {
        guard let folder, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: folder.appendingPathComponent("\(label)-\(appearance ?? "light")-\(name).png"))
    }
}
#endif

@MainActor
final class AppModel: ObservableObject {
    enum Screen { case connect, web }

    @Published private(set) var server: String?
    @Published var screen: Screen {
        didSet { applyWindowTheme() }
    }
    @Published var address: String
    @Published var connectError: String?
    @Published private(set) var connecting = false
    /// What the page says it is drawn in (`setTheme`), so the window around it matches; nil on Connect.
    @Published private(set) var pageBackground: NSColor?
    @Published private(set) var pageDark: Bool?
    /// The page follows the system, so the app mustn't pin an appearance: the web view would then only ever see that one.
    @Published private(set) var pageFollowsSystem = false
    @Published var progress: Double = 1

    let ui = NativeUI()
    private(set) lazy var shell = WebShell(model: self)
    private let signIn = SignIn()
    private(set) weak var window: NSWindow?
    /// Opens the window again after it was closed (SwiftUI's `openWindow`, which only a view can reach).
    var reopen: (@MainActor () -> Void)?
    private var started = false
    private var keys: Any?

    init() {
        #if DEBUG
        if let server = Screens.server { Prefs.server = server }
        #endif
        let saved = Prefs.server
        var first: Screen = saved == nil ? .connect : .web
        #if DEBUG
        if Screens.connect { first = .connect }
        #endif
        server = saved
        address = saved ?? ""
        screen = first
    }

    /// Once, when the window first shows; it may close and open again while the app runs.
    func start() {
        guard !started else { return }
        started = true
        watchKeys()
        Notifications.shared.onOpen = { [weak self] url in self?.openNotice(url) }
        // A click on a notification that launched the app opens its conversation, not the list.
        let target = Notifications.shared.takePendingOpen() ?? "/app"
        #if DEBUG
        if screen == .web, let server, let cookie = Screens.cookie, let path = Screens.path {
            Task {
                await shell.setCookie(cookie, for: server)
                open(path)
            }
            return
        }
        #endif
        if server != nil && screen == .web { open(target) }
    }

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window
        ui.window = window
        signIn.anchor = window
        window.tabbingMode = .disallowed
        applyWindowTheme()
        #if DEBUG
        if Screens.active {
            // After SwiftUI has placed it: as big as the screenshots are meant to be, but all of it on the
            // runner's small screen, or the parts off the edge can't be clicked or seen.
            Task {
                let visible = (window.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
                let size = NSSize(width: min(1440, visible.width), height: min(900, visible.height))
                window.setFrame(NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2, width: size.width, height: size.height), display: true)
                Screens.note("window \(NSStringFromRect(window.frame)) on \(NSStringFromRect(visible))")
            }
        }
        #endif
    }

    /// Connect can go back to the Gond it came from when one is loaded.
    var canGoBack: Bool { server != nil && shell.hasPage }

    /// Connect over the page, which stays as it is behind it for Back.
    func showConnect(error: String? = nil) {
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
        // A different Gond: its own sign-in, not the last one's, and none of its pieces or colours.
        if found != server {
            await shell.forgetEverything()
            ui.clear()
            resetTheme()
        }
        server = found
        Prefs.server = found
        open("/login")
    }

    /// A path on the connected Gond, like /app/t/…, or a whole address there, loaded afresh.
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

    /// A clicked notification: the window comes forward and its conversation opens, in its own profile.
    private func openNotice(_ url: String) {
        if window?.isVisible != true { reopen?() }
        window?.makeKeyAndOrderFront(nil)
        open(url)
    }

    func startSignIn(next: String?) {
        guard let server else { return }
        signIn.start(server: server, next: next) { [weak self] path in self?.open(path) }
    }

    // MARK: Menus and keys

    /// The page draws everything a shortcut would open, so nothing goes while something of its own is open.
    var shortcutsWork: Bool { screen == .web && !ui.covered }

    func openSettings() {
        guard shortcutsWork else { return }
        if ui.sidebar != nil {
            ui.sendSidebar(["type": "open", "path": "/app/settings"])
        } else {
            open("/app/settings")
        }
    }

    func newBot() {
        guard shortcutsWork, ui.sidebar != nil else { return }
        ui.sendSidebar(["type": "new", "id": "new-bot"])
    }

    private func watchKeys() {
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let handled = MainActor.assumeIsolated { self?.handleKey(event) ?? false }
            return handled ? nil : event
        }
    }

    /// ⌘F reaches the sidebar's search wherever the focus is, and Escape closes what covers the
    /// conversation when the page can't hear it (the focus is in the app's own pieces).
    private func handleKey(_ event: NSEvent) -> Bool {
        guard screen == .web, let window, event.window === window, window.attachedSheet == nil else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        if event.keyCode == 53 && flags.isEmpty && ui.covered && !shell.hasFocus {
            ui.dismissCover()
            return true
        }
        if flags == .command && event.charactersIgnoringModifiers?.lowercased() == "f" && shortcutsWork && ui.sidebar?.settings == false {
            ui.focusSearch()
            return true
        }
        return false
    }

    // MARK: The page's theme

    func applyTheme(background: String?, dark: Bool, system: Bool) {
        if let background, let color = NSColor(css: background) { pageBackground = color }
        pageDark = dark
        pageFollowsSystem = system
        applyWindowTheme()
    }

    private func resetTheme() {
        pageBackground = nil
        pageDark = nil
        pageFollowsSystem = false
        applyWindowTheme()
    }

    /// The window wears the page's colours, so the glass over it matches; on Connect and while the page
    /// follows the system, the system's.
    private func applyWindowTheme() {
        guard let window else { return }
        let web = screen == .web
        window.backgroundColor = web ? (pageBackground ?? .windowBackgroundColor) : .windowBackgroundColor
        if web, !pageFollowsSystem, let dark = pageDark {
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        } else {
            window.appearance = nil
        }
        if web, let background = pageBackground { shell.webView.underPageBackgroundColor = background }
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
