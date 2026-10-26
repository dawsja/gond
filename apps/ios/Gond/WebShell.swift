import os
import SafariServices
import UIKit
import WebKit

private let shellLog = Logger(subsystem: "io.gond.ios", category: "shell")

/// The web view that shows your Gond, and the `gondMobile` bridge its pages talk to.
@MainActor
final class WebShell: NSObject {
    /** Kept in step with MCP_LOOPBACK_PORT in packages/shared. */
    static let loopbackPort = 47651

    let webView: WKWebView
    private weak var model: AppModel?
    private(set) var hasPage = false
    private var ownPage = false
    private var typing = false
    private var server: String?
    private var notificationsState = "prompt"
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var progressObservation: NSKeyValueObservation?

    init(model: AppModel) {
        self.model = model
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.applicationNameForUserAgent = "Mobile/15E148 Gond/\(AppInfo.version) (iOS)"
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        model.ui.shell = self
        configuration.userContentController.add(ScriptHandler(self), name: "gondMobile")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // Your Gond's pages draw under the status bar and the home indicator and pad for them
        // themselves (pushInsets), as the Android app's do.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // The web app has its own swipe back from the left edge.
        webView.allowsBackForwardNavigationGestures = false
        // A long press is the page's (a message's menu, which the app draws): WebKit's own previews
        // and menus would start under it and take the next tap to go away.
        webView.allowsLinkPreview = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            let value = web.estimatedProgress
            Task { @MainActor in self?.model?.progress = value }
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func load(server: String, path: String) {
        if self.server != server {
            self.server = server
            installBridge()
        }
        guard let url = URL(string: server + path) else { return }
        webView.load(URLRequest(url: url))
    }

    /// Another Gond's sign-in and pages have no business in this one's web view.
    func forgetEverything() async {
        let store = webView.configuration.websiteDataStore
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        hasPage = false
    }

    // MARK: The bridge

    /*
     * `gondMobile` is defined only in the connected Gond's own pages (the script checks the
     * origin before defining it), and every message is checked again against the server before
     * anything happens, so a page from another origin (a provider's sign-in) can't use it.
     * WebKit's messages are one way, so what the page reads back (platform, version, the
     * notification permission) is written into the script and kept current with an event.
     */
    private func installBridge() {
        guard let server else { return }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let script = Self.bridgeScript(server: server, version: AppInfo.version, notifications: notificationsState)
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        controller.addUserScript(WKUserScript(source: Self.consoleScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        Task { await refreshNotificationsState() }
    }

    static func bridgeScript(server: String, version: String, notifications: String) -> String {
        func json(_ value: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
            return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
        }
        return """
        (function () {
          if (location.origin !== \(json(server))) return;
          var state = \(json(notifications));
          window.addEventListener("gond:notifications-state", function (event) { state = event.detail; });
          function post(action, args) { window.webkit.messageHandlers.gondMobile.postMessage({ action: action, args: args || [] }); }
          window.gondMobile = {
            platform: function () { return "ios"; },
            version: function () { return \(json(version)); },
            features: function () { return ["call"]; },
            changeServer: function () { post("changeServer"); },
            notify: function (title, body, url, tag) { post("notify", [String(title || ""), String(body || ""), String(url || ""), String(tag || "")]); },
            notificationsState: function () { return state; },
            requestNotifications: function () { post("requestNotifications"); },
            signIn: function (next) { post("signIn", [String(next || "")]); },
            openExternal: function (url) { post("openExternal", [String(url || "")]); },
            setTheme: function (background, dark, system) { post("setTheme", [String(background || ""), Boolean(dark), Boolean(system)]); },
            present: function (kind, request) { post("present", [String(kind || ""), String(request || "")]); },
            chrome: function (state) { post("chrome", [String(state || "null")]); }
          };
        })();
        """
    }

    #if DEBUG
    /// The page's errors and warnings in the app's log, for the screenshot job.
    private static let consoleScript = """
    (function () {
      function send(level, args) {
        try { window.webkit.messageHandlers.gondMobile.postMessage({ action: "console", args: [level, Array.prototype.map.call(args, String).join(" ")] }); } catch (e) {}
      }
      ["error", "warn", "info"].forEach(function (level) {
        var original = console[level];
        console[level] = function () { send(level, arguments); return original.apply(console, arguments); };
      });
      window.addEventListener("error", function (event) { send("error", [event.message, event.error && event.error.stack]); });
      window.addEventListener("unhandledrejection", function (event) { send("error", ["unhandled", event.reason, event.reason && event.reason.stack]); });
    })();
    """
    #endif

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let server, ServerURL.sameOrigin(webView.url, server) else { return }
        let origin = message.frameInfo.securityOrigin
        guard ServerURL.origin(scheme: origin.`protocol`, host: origin.host, port: origin.port) == server else { return }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        #if DEBUG
        if action != "chrome" && action != "console" { shellLog.notice("bridge \(action, privacy: .public)") }
        #endif
        let text = { (i: Int) -> String in i < args.count ? (args[i] as? String ?? "") : "" }
        switch action {
        case "changeServer":
            model?.showConnect()
        case "notify":
            Notifications.shared.show(title: text(0).isEmpty ? "Gond" : text(0), body: text(1), url: text(2).isEmpty ? "/app" : text(2), tag: text(3).isEmpty ? text(2) : text(3))
        case "requestNotifications":
            Task {
                await Notifications.shared.request()
                await refreshNotificationsState()
            }
        case "signIn":
            let next = text(0)
            model?.startSignIn(next: next.hasPrefix("/") && !next.hasPrefix("//") ? next : "/app")
        case "openExternal":
            if let url = URL(string: text(0)) { openOutside(url) }
        case "setTheme":
            model?.applyTheme(background: text(0), dark: args.count > 1 ? (args[1] as? Bool ?? false) : false, system: args.count > 2 ? (args[2] as? Bool ?? false) : false)
        case "present":
            model?.ui.present(kind: text(0), json: text(1))
        #if DEBUG
        case "console":
            shellLog.notice("page \(text(0), privacy: .public): \(text(1), privacy: .public)")
        #endif
        case "chrome":
            model?.ui.setChrome(text(0))
        default:
            break
        }
    }

    private func refreshNotificationsState() async {
        let state = await Notifications.shared.state()
        let changed = state != notificationsState
        notificationsState = state
        if changed, let server {
            let script = Self.bridgeScript(server: server, version: AppInfo.version, notifications: state)
            let controller = webView.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // The web app's notifications card reads the state again on gond:notifications.
        let js = "window.dispatchEvent(new CustomEvent('gond:notifications-state', { detail: '\(state)' }));window.dispatchEvent(new Event('gond:notifications'));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: The app's own pieces (NativeUI)

    /// An event the page listens for; only ever the connected Gond's own page hears it.
    func dispatch(_ name: String, _ detail: [String: Any]) {
        guard ownPage, let data = try? JSONSerialization.data(withJSONObject: detail) else { return }
        let json = String(decoding: data, as: UTF8.self)
        let event = name == "gond:native" ? "gond:native" : "gond:native-chrome"
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)', { detail: \(json) }))", completionHandler: nil)
    }

    /// What a part of the page looks like now, for a message lifted into its menu.
    func snapshot(_ rect: CGRect) async -> UIImage? {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        // After the page hid what hangs off the bubble (its reactions) for the lifted copy.
        configuration.afterScreenUpdates = true
        return await withCheckedContinuation { continuation in
            webView.takeSnapshot(with: configuration) { image, _ in continuation.resume(returning: image) }
        }
    }

    /// A path on the connected Gond, fetched by the page itself in a world of the app's own: its
    /// session and its cache, so a picture it already shows comes at once and no cookie is copied out.
    func fetch(_ path: String) async throws -> Data {
        guard ownPage, path.hasPrefix("/"), !path.hasPrefix("//") else { throw URLError(.badURL) }
        let body = """
        const response = await fetch(path, { credentials: "same-origin" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
        """
        let result = try await webView.callAsyncJavaScript(body, arguments: ["path": path], contentWorld: .defaultClient)
        guard let base64 = result as? String, let data = Data(base64Encoded: base64) else { throw URLError(.cannotDecodeContentData) }
        return data
    }

    /// Where the app's composer sits, so the page keeps its own (unseen) under it and pads the messages to match.
    func setComposerMetrics(_ metrics: (bottom: CGFloat, height: CGFloat)?) {
        guard ownPage else { return }
        let script = metrics.map { "s.setProperty('--native-composer-bottom','\($0.bottom)px');s.setProperty('--native-composer-height','\($0.height)px');" }
            ?? "s.removeProperty('--native-composer-bottom');s.removeProperty('--native-composer-height');"
        webView.evaluateJavaScript("(function(s){\(script)})(document.documentElement.style)", completionHandler: nil)
    }

    #if DEBUG
    /// The seeded session the screenshot job signs in with, as `name=value`.
    func setCookie(_ pair: String, for server: String) async {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, let host = URL(string: server)?.host,
              let cookie = HTTPCookie(properties: [.name: parts[0], .value: parts[1], .domain: host, .path: "/"]) else { return }
        await withCheckedContinuation { continuation in
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { continuation.resume() }
        }
    }
    #endif

    // MARK: The page's edges

    /// The status bar and home indicator, as the web app's --safe-* variables read them.
    func pushInsets(_ insets: UIEdgeInsets) {
        guard ownPage else { return }
        let values = [
            "--shell-inset-top": insets.top,
            "--shell-inset-bottom": typing ? 0 : insets.bottom,
            "--shell-inset-left": insets.left,
            "--shell-inset-right": insets.right,
        ]
        let script = values.map { "s.setProperty('\($0.key)','\($0.value)px');" }.joined()
        webView.evaluateJavaScript("(function(s){\(script)})(document.documentElement.style)", completionHandler: nil)
    }

    @objc private func keyboardChanged(_ note: Notification) {
        typing = note.name == UIResponder.keyboardWillShowNotification
        pushInsets(webView.safeAreaInsets)
    }

    @objc private func cameBack() {
        Task { await refreshNotificationsState() }
    }

    // MARK: Leaving the app

    func openOutside(_ url: URL) {
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" {
            let safari = SFSafariViewController(url: url)
            UIApplication.shared.topViewController?.present(safari, animated: true)
        } else {
            UIApplication.shared.open(url) { opened in
                if !opened { UIApplication.shared.topViewController?.showNotice("Nothing on this phone can open that link.") }
            }
        }
    }

    private func isLoopbackCallback(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = parts.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) && parts.port == Self.loopbackPort && parts.path == "/callback" && parts.queryItems?.contains { $0.name == "state" } == true
    }
}

extension WebShell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let scheme = url.scheme?.lowercased()
        if scheme != "http" && scheme != "https" && scheme != "about" && scheme != "blob" && scheme != "data" {
            openOutside(url)
            return decisionHandler(.cancel)
        }
        // The localhost end of an MCP sign-in (MCP_LOOPBACK_CALLBACK in packages/shared):
        // finished on the server's own callback, as the desktop and Android apps do.
        if isLoopbackCallback(url), let server, let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery,
           let callback = URL(string: "\(server)/api/mcp-servers/oauth/callback?\(query)") {
            webView.load(URLRequest(url: callback))
            return decisionHandler(.cancel)
        }
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        // Everything else loads here: your Gond's pages, and a sign-in the page started
        // (Composio, an MCP server's OAuth) so it comes back with the session.
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if navigationResponse.isForMainFrame && (!navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment")) {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        ownPage = ServerURL.sameOrigin(webView.url, server)
        model?.ui.clear()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        ownPage = ServerURL.sameOrigin(webView.url, server)
        hasPage = true
        pushInsets(webView.safeAreaInsets)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushInsets(webView.safeAreaInsets)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        // A navigation cut short on purpose (a download, a link sent elsewhere) isn't a failure.
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        let failing = (failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        guard let server, ServerURL.sameOrigin(failing, server) else { return }
        model?.showConnect(error: "Couldn't reach \(server) (\(failure.localizedDescription)).")
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebShell: WKUIDelegate {
    /// A link that opens a new window: your Gond's own pages load here, anything else in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.absoluteString != "about:blank" {
            if ServerURL.sameOrigin(url, server) { webView.load(navigationAction.request) } else { openOutside(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo, completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
        completionHandler(nil)
    }

    /// The microphone, for the composer's voice button, and only for the person's own Gond.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let mine = ServerURL.origin(scheme: origin.`protocol`, host: origin.host, port: origin.port) == server
        decisionHandler(type == .microphone && mine && frame.isMainFrame ? .grant : .deny)
    }
}

extension WebShell: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let destination = folder.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = destination
        return destination
    }

    /// A saved attachment goes to the share sheet, where Save to Files, AirDrop or another app takes it.
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)), let top = UIApplication.shared.topViewController else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = top.view
        top.present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        UIApplication.shared.topViewController?.showNotice("Couldn't download that file. Try again.")
    }
}

/// WebKit keeps its message handlers for good, so this holds the shell weakly.
private final class ScriptHandler: NSObject, WKScriptMessageHandler {
    weak var shell: WebShell?

    init(_ shell: WebShell) {
        self.shell = shell
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { shell?.receive(message) }
    }
}

extension UIApplication {
    var topViewController: UIViewController? {
        let scenes = connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

extension UIViewController {
    func showNotice(_ text: String) {
        let alert = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
