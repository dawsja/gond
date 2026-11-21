import AppKit
import os
import SwiftUI
import WebKit

private let shellLog = Logger(subsystem: "io.gond.mac", category: "shell")

/// The web view that shows your Gond, and the `gondMac` bridge its pages talk to.
@MainActor
final class WebShell: NSObject {
    /** Kept in step with MCP_LOOPBACK_PORT in packages/shared. */
    static let loopbackPort = 47651
    /// The only events the app ever raises on the page.
    private static let events: Set<String> = ["gond:native", "gond:native-chrome", "gond:native-sidebar", "gond:download"]

    let webView: GondWebView
    private weak var model: AppModel?
    private(set) var hasPage = false
    private(set) var ownPage = false
    private var server: String?
    private var notificationsState = "prompt"
    private var insetTop: CGFloat = 0
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var pdfPreviews: [ObjectIdentifier: URL] = [:]
    /// Finished downloads by the id their `gond:download` event carried, for `showDownload`.
    private var saved: [Int: URL] = [:]
    private var lastDownload = 0
    private var progressObservation: NSKeyValueObservation?

    init(model: AppModel) {
        self.model = model
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Safari's own words first, so the sites a sign-in passes through treat this as Safari.
        configuration.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15 Gond/\(AppInfo.version) (macOS)"
        webView = GondWebView(frame: .zero, configuration: configuration)
        super.init()
        model.ui.shell = self
        webView.configuration.userContentController.add(ScriptHandler(self), name: "gondMac")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // A swipe back would leave the web app's own history behind its back.
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            let value = web.estimatedProgress
            Task { @MainActor in self?.model?.progress = value }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: NSApplication.didBecomeActiveNotification, object: nil)
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

    /// The focus is somewhere in the page, so it hears the keys itself.
    var hasFocus: Bool {
        guard let responder = webView.window?.firstResponder as? NSView else { return false }
        return responder === webView || responder.isDescendant(of: webView)
    }

    /// Something of the page's opened over the conversation: the keys go to it, not to the app's composer.
    func focusPage() {
        guard let window = webView.window, !hasFocus else { return }
        _ = window.makeFirstResponder(webView)
    }

    // MARK: The bridge

    /*
     * `gondMac` is defined only in the connected Gond's own pages (the script checks the origin
     * before defining it), and every message is checked again against the server before anything
     * happens, so a page from another origin (a provider's sign-in) can't use it. WebKit's messages
     * are one way, so what the page reads back (platform, version, the notification permission) is
     * written into the script and kept current with an event.
     */
    private func installBridge() {
        rewriteBridge()
        Task { await refreshNotificationsState() }
    }

    /// The script carries what the page reads back and the toolbar's height, so a page loaded later starts with both.
    private func rewriteBridge() {
        guard let server else { return }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let script = Self.bridgeScript(server: server, version: AppInfo.version, notifications: notificationsState, insetTop: insetTop)
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        controller.addUserScript(WKUserScript(source: Self.consoleScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
    }

    nonisolated static func bridgeScript(server: String, version: String, notifications: String, insetTop: CGFloat) -> String {
        func json(_ value: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
            return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
        }
        let top = insetTop.isFinite ? max(0, insetTop) : 0
        return """
        (function () {
          if (location.origin !== \(json(server))) return;
          var style = document.documentElement && document.documentElement.style;
          if (style) {
            style.setProperty("--shell-inset-top", "\(top)px");
            style.setProperty("--shell-inset-bottom", "0px");
            style.setProperty("--shell-inset-left", "0px");
            style.setProperty("--shell-inset-right", "0px");
          }
          var state = \(json(notifications));
          window.addEventListener("gond:notifications-state", function (event) { state = event.detail; });
          function post(action, args) { window.webkit.messageHandlers.gondMac.postMessage({ action: action, args: args || [] }); }
          window.gondMac = {
            platform: function () { return "macos"; },
            version: function () { return \(json(version)); },
            features: function () { return ["call", "scale", "sidebar"]; },
            changeServer: function () { post("changeServer"); },
            signIn: function (next) { post("signIn", [String(next || "")]); },
            notify: function (title, body, url, tag) { post("notify", [String(title || ""), String(body || ""), String(url || ""), String(tag || "")]); },
            notificationsState: function () { return state; },
            requestNotifications: function () { post("requestNotifications"); },
            openExternal: function (url) { post("openExternal", [String(url || "")]); },
            setTheme: function (background, dark, system) { post("setTheme", [String(background || ""), Boolean(dark), Boolean(system)]); },
            setScale: function (scale) { post("setScale", [Number(scale) || 1]); },
            present: function (kind, request) { post("present", [String(kind || ""), String(request || "")]); },
            chrome: function (json) { post("chrome", [String(json || "null")]); },
            sidebar: function (json) { post("sidebar", [String(json || "null")]); },
            showDownload: function (id) { post("showDownload", [Number(id)]); }
          };
        })();
        """
    }

    #if DEBUG
    /// The page's errors and warnings in the app's log, for the screenshot job.
    private static let consoleScript = """
    (function () {
      function send(level, args) {
        try { window.webkit.messageHandlers.gondMac.postMessage({ action: "console", args: [level, Array.prototype.map.call(args, String).join(" ")] }); } catch (e) {}
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
        if action != "chrome" && action != "sidebar" && action != "console" { shellLog.notice("bridge \(action, privacy: .public)") }
        #endif
        let text = { (i: Int) -> String in i < args.count ? (args[i] as? String ?? "") : "" }
        let flag = { (i: Int) -> Bool in i < args.count ? (args[i] as? Bool ?? false) : false }
        switch action {
        case "changeServer":
            model?.showConnect()
        case "signIn":
            let next = text(0)
            model?.startSignIn(next: next.hasPrefix("/") && !next.hasPrefix("//") ? next : "/app")
        case "notify":
            Notifications.shared.show(title: text(0).isEmpty ? "Gond" : text(0), body: text(1), url: text(2).isEmpty ? "/app" : text(2), tag: text(3).isEmpty ? text(2) : text(3))
        case "requestNotifications":
            Task {
                await Notifications.shared.request()
                await refreshNotificationsState()
            }
        case "openExternal":
            if let url = URL(string: text(0)) { openOutside(url) }
        case "setTheme":
            model?.applyTheme(background: text(0), dark: flag(1), system: flag(2))
        case "setScale":
            model?.ui.setScale((args.first as? NSNumber)?.doubleValue ?? 1)
        case "present":
            model?.ui.present(kind: text(0), json: text(1))
        case "chrome":
            model?.ui.setChrome(text(0))
        case "sidebar":
            model?.ui.setSidebar(text(0))
        case "showDownload":
            if let id = (args.first as? NSNumber)?.intValue, let file = saved[id] {
                if FileManager.default.fileExists(atPath: file.path) {
                    NSWorkspace.shared.activateFileViewerSelecting([file])
                } else {
                    model?.ui.notice("That file isn't in Downloads anymore.")
                }
            }
        #if DEBUG
        case "console":
            shellLog.notice("page \(text(0), privacy: .public): \(text(1), privacy: .public)")
        #endif
        default:
            break
        }
    }

    private func refreshNotificationsState() async {
        let state = await Notifications.shared.state()
        let changed = state != notificationsState
        notificationsState = state
        if changed { rewriteBridge() }
        // The web app's notifications card reads the state again on gond:notifications.
        let js = "window.dispatchEvent(new CustomEvent('gond:notifications-state', { detail: '\(state)' }));window.dispatchEvent(new Event('gond:notifications'));"
        if ownPage { webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    @objc private func cameBack() {
        Task { await refreshNotificationsState() }
    }

    // MARK: The app's own pieces (NativeUI)

    /// An event the page listens for; only ever the connected Gond's own page hears it.
    func dispatch(_ name: String, _ detail: [String: Any]) {
        guard ownPage, Self.events.contains(name), JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail) else { return }
        let json = String(decoding: data, as: UTF8.self)
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(name)', { detail: \(json) }))", completionHandler: nil)
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

    /// How much of the web view's top the window's toolbar covers, as the page's --safe-top reads it.
    func setInsetTop(_ top: CGFloat) {
        let value = top.isFinite ? max(0, top.rounded()) : 0
        guard value != insetTop else { return }
        insetTop = value
        rewriteBridge()
        pushInsets()
    }

    private func pushInsets() {
        guard ownPage else { return }
        let script = "s.setProperty('--shell-inset-top','\(insetTop)px');s.setProperty('--shell-inset-bottom','0px');s.setProperty('--shell-inset-left','0px');s.setProperty('--shell-inset-right','0px');"
        webView.evaluateJavaScript("(function(s){\(script)})(document.documentElement.style)", completionHandler: nil)
    }

    /// Where a menu the page asked for opens: at the pointer when it is over that part of the page, else under it.
    func menuPoint(for rect: CGRect?) -> NSPoint {
        if let window = webView.window {
            let pointer = webView.convert(window.mouseLocationOutsideOfEventStream, from: nil)
            if webView.bounds.contains(pointer) { return pointer }
        }
        guard let rect else { return NSPoint(x: webView.bounds.midX, y: webView.bounds.midY) }
        return NSPoint(x: rect.minX, y: webView.isFlipped ? rect.maxY : webView.bounds.height - rect.maxY)
    }

    #if DEBUG
    /// The seeded session the screenshot job signs in with, as `name=value`.
    func setCookie(_ pair: String, for server: String) async {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, let host = URL(string: server)?.host,
              let cookie = HTTPCookie(properties: [.name: parts[0], .value: parts[1], .domain: host, .path: "/"]) else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { continuation.resume() }
        }
    }
    #endif

    // MARK: Leaving the app

    func openOutside(_ url: URL) {
        if !NSWorkspace.shared.open(url) {
            model?.ui.notice("Nothing on this Mac can open that link.")
        }
    }

    private func isLoopbackCallback(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = parts.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) && parts.port == Self.loopbackPort && parts.path == "/callback" && parts.queryItems?.contains { $0.name == "state" } == true
    }

    // MARK: Downloads

    private static func freeName(_ suggested: String, in folder: URL) -> URL {
        var name = suggested.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "download" }
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var number = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)")
            number += 1
        }
        return candidate
    }
}

/// The page's web view, with WebKit's own right-click menu kept to what makes sense inside an app.
final class GondWebView: WKWebView {
    private static let unwanted: Set<String> = [
        "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierOpenMediaInNewWindow", "WKMenuItemIdentifierDownloadMedia",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let items = menu.items.filter { !Self.unwanted.contains($0.identifier?.rawValue ?? "") }
        // No separator first, last or twice in a row once those are gone.
        var tidy: [NSMenuItem] = []
        for item in items {
            if item.isSeparatorItem && (tidy.isEmpty || tidy.last?.isSeparatorItem == true) { continue }
            tidy.append(item)
        }
        while tidy.last?.isSeparatorItem == true { tidy.removeLast() }
        menu.items = tidy
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
        // finished on the server's own callback, as the iPhone and Android apps do.
        if isLoopbackCallback(url), let server, let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery,
           let callback = URL(string: "\(server)/api/mcp-servers/oauth/callback?\(query)") {
            webView.load(URLRequest(url: callback))
            return decisionHandler(.cancel)
        }
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        // A link on your Gond's pages to another site opens in the browser. Anything else loads here:
        // your Gond's pages, and a sign-in the page started (Composio, an MCP server's OAuth), so it
        // comes back with the session, links on the provider's pages included.
        if navigationAction.navigationType == .linkActivated, navigationAction.targetFrame?.isMainFrame != false,
           ownPage, !ServerURL.sameOrigin(url, server), scheme == "http" || scheme == "https" {
            openOutside(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { return decisionHandler(.allow) }
        let response = navigationResponse.response as? HTTPURLResponse
        let download = !navigationResponse.canShowMIMEType || isAttachmentDownload(response) || pdfPreviewSource(navigationResponse) != nil
        decisionHandler(download ? .download : .allow)
    }

    private func isAttachmentDownload(_ response: HTTPURLResponse?) -> Bool {
        response?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
    }

    /// A PDF of your Gond's own that the page opened: Quick Look shows it, and going back is closing it.
    private func pdfPreviewSource(_ navigation: WKNavigationResponse) -> URL? {
        guard navigation.isForMainFrame, ownPage,
              let response = navigation.response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode), response.mimeType == "application/pdf",
              ServerURL.sameOrigin(response.url, server), !isAttachmentDownload(response),
              let source = webView.backForwardList.currentItem?.url, ServerURL.sameOrigin(source, server) else { return nil }
        return source
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        ownPage = ServerURL.sameOrigin(webView.url, server)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        ownPage = ServerURL.sameOrigin(webView.url, server)
        hasPage = true
        // A provisional load that becomes a download leaves the current page and its chrome in place.
        model?.ui.pageChanged(appPage: ownPage && (webView.url?.path.hasPrefix("/app") ?? false))
        pushInsets()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushInsets()
        model?.ui.pageLoaded()
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
        pdfPreviews[ObjectIdentifier(download)] = pdfPreviewSource(navigationResponse)
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebShell: WKUIDelegate {
    /// A link that opens a new window: your Gond's own pages load here, anything else in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.absoluteString != "about:blank" {
            if ServerURL.sameOrigin(url, server) { webView.load(navigationAction.request) } else { openOutside(url) }
        }
        return nil
    }

    /// A file field on a page (a picture for your profile, a file for a bot): the Mac's own Open panel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
            return
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        guard let window = webView.window else {
            _ = alert.runModal()
            completionHandler()
            return
        }
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        guard let window = webView.window else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
            return
        }
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    /// The microphone, for the composer's voice button and calls, and only for the person's own Gond.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let mine = ServerURL.origin(scheme: origin.`protocol`, host: origin.host, port: origin.port) == server
        decisionHandler(type == .microphone && mine && frame.isMainFrame ? .grant : .deny)
    }
}

extension WebShell: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let id = ObjectIdentifier(download)
        let manager = FileManager.default
        let folder: URL
        if pdfPreviews[id] != nil {
            folder = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        } else {
            guard let downloads = manager.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return nil }
            folder = downloads
        }
        guard (try? manager.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else {
            pdfPreviews.removeValue(forKey: id)
            return nil
        }
        var name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        if pdfPreviews[id] != nil && (name as NSString).pathExtension.lowercased() != "pdf" { name += ".pdf" }
        let destination = Self.freeName(name, in: folder)
        downloads[id] = destination
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        let previewSource = pdfPreviews.removeValue(forKey: id)
        guard let file = downloads.removeValue(forKey: id) else { return }
        if let previewSource {
            if ownPage, webView.backForwardList.currentItem?.url == previewSource, let model, model.screen == .web, model.ui.previewPDF(file) { return }
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            return
        }
        lastDownload += 1
        saved[lastDownload] = file
        // The Dock's Downloads stack bounces, as it does for Safari's.
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: file.path)
        dispatch("gond:download", ["ok": true, "id": lastDownload, "name": file.lastPathComponent, "folder": "Downloads"])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        let previewSource = pdfPreviews.removeValue(forKey: id)
        let file = downloads.removeValue(forKey: id)
        if previewSource != nil {
            if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            model?.ui.notice("Couldn't open that PDF. Try again.")
            return
        }
        var detail: [String: Any] = ["ok": false, "id": NSNull(), "name": NSNull(), "folder": NSNull()]
        if let file {
            detail["name"] = file.lastPathComponent
            try? FileManager.default.removeItem(at: file)
        }
        dispatch("gond:download", detail)
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

/// The web view in the window: the same one for as long as the app runs, so a closed and reopened
/// window, or a trip to Connect and back, keeps the page as it was.
struct WebContainer: NSViewRepresentable {
    let shell: WebShell

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        place(in: view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        if shell.webView.superview == nil { place(in: view) }
    }

    private func place(in view: NSView) {
        let web = shell.webView
        web.removeFromSuperview()
        web.frame = view.bounds
        web.autoresizingMask = [.width, .height]
        view.addSubview(web)
    }
}
