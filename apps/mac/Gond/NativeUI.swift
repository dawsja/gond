import AppKit
import os
import SwiftUI
import UniformTypeIdentifiers

/*
 * What the app draws itself around your Gond's pages (apps/web/lib/native-ui.ts): the sidebar, a
 * conversation's toolbar and composer, a confirm, a message's right-click menu, the pictures in
 * Quick Look and a toast. The page asks with `present` and hears the answer as a `gond:native` event;
 * the chrome and the sidebar come in as state and go back as `gond:native-chrome` and
 * `gond:native-sidebar` events. Everything here acts only through those events, so the page stays
 * the one that decides what happens.
 */

private let log = Logger(subsystem: "io.gond.mac", category: "native")

@MainActor
final class NativeUI: ObservableObject {
    @Published private(set) var chrome: ChromeState?
    @Published private(set) var sidebar: SidebarState?
    /// Whether the window shows the sidebar column, which the person can also toggle; hidden until the page draws one.
    @Published var columns: NavigationSplitViewVisibility = .detailOnly
    @Published private(set) var toast: ToastRequest?
    /// The conversation's faces for the toolbar, front one first.
    @Published private(set) var faces: [NSImage] = []
    @Published private(set) var mentionFaces: [String: NSImage] = [:]
    /// The sidebar's faces by key, kept for the page's whole life since it sends each only once.
    @Published private(set) var sidebarFaces: [String: NSImage] = [:]
    @Published private(set) var opening = false
    /// How many points a CSS pixel takes on the page (Settings → Appearance → Size); the composer is drawn at it.
    @Published private(set) var scale: CGFloat = 1
    @Published private(set) var searchRequest = 0
    /// Raised by each new page, so the sidebar starts over with it.
    @Published private(set) var page = 0
    /// The page is one of the web app's own screens, which run under the toolbar and pad their top for it.
    @Published private(set) var appPage = false
    @Published private(set) var toolbarHeight: CGFloat = 0
    @Published private(set) var preview: URL?
    @Published private(set) var previewFiles: [URL] = []

    weak var shell: WebShell?
    weak var window: NSWindow?
    private var faceSources: [String] = []
    private var mentionSources: [String: String] = [:]
    private var picturesAsked: String?
    private var toastTimer: Task<Void, Never>?
    /// A new page sends every face again with its first sidebar; the last page's stay until then.
    private var facesFresh = true
    private var sidebarSeen = false
    private var sidebarCheck: Task<Void, Never>?

    var covered: Bool { chrome?.covered == true || sidebar?.covered == true }

    // MARK: From the page

    func setScale(_ value: Double) {
        let next = CGFloat(min(max(value.isFinite ? value : 1, 1), 1.5))
        if next != scale { scale = next }
    }

    func setChrome(_ json: String) {
        let wasCovered = covered
        let state = json == "null" ? nil : (try? JSONDecoder().decode(ChromeState.self, from: Data(json.utf8)))
        guard let state else {
            if chrome != nil { chrome = nil }
            shell?.setComposerMetrics(nil)
            coveredChanged(from: wasCovered)
            return
        }
        if state.faces != faceSources {
            faceSources = state.faces
            faces = state.faces.compactMap(Self.image(dataURL:))
        }
        let sources = Dictionary(state.mentions.compactMap { m in m.face.map { (m.id, $0) } }, uniquingKeysWith: { a, _ in a })
        if sources != mentionSources {
            mentionSources = sources
            mentionFaces = sources.compactMapValues(Self.image(dataURL:))
        }
        if state != chrome { chrome = state }
        coveredChanged(from: wasCovered)
    }

    func setSidebar(_ json: String) {
        let wasCovered = covered
        let state = json == "null" ? nil : (try? JSONDecoder().decode(SidebarState.self, from: Data(json.utf8)))
        guard let state else {
            if json != "null" { log.error("sidebar couldn't be read") }
            if sidebar != nil { sidebar = nil }
            if columns != .detailOnly { columns = .detailOnly }
            coveredChanged(from: wasCovered)
            return
        }
        sidebarSeen = true
        if facesFresh || !state.faces.isEmpty {
            var next = facesFresh ? [:] : sidebarFaces
            for (key, source) in state.faces {
                if let image = Self.image(dataURL: source) { next[key] = image }
            }
            facesFresh = false
            sidebarFaces = next
        }
        if sidebar == nil { columns = .all }
        if state != sidebar { sidebar = state }
        coveredChanged(from: wasCovered)
    }

    func sidebarFace(_ key: String?) -> NSImage? {
        guard let key, !key.isEmpty else { return nil }
        if key.hasPrefix("data:") { return Self.image(dataURL: key) }
        return sidebarFaces[key]
    }

    func setToolbarHeight(_ height: CGFloat) {
        let value = height.isFinite ? max(0, height.rounded()) : 0
        if value != toolbarHeight { toolbarHeight = value }
    }

    /// Set as a page is asked for, so the web view is in its place before the page first paints.
    func expect(appPage: Bool) {
        if self.appPage != appPage { self.appPage = appPage }
    }

    /// A new page, or another site's: none of the chrome stays, and the sidebar only until the new
    /// page draws its own, so a reload doesn't fold it away and back.
    func pageChanged(appPage: Bool) {
        expect(appPage: appPage)
        setChrome("null")
        page += 1
        facesFresh = true
        sidebarSeen = false
        sidebarCheck?.cancel()
        if !appPage {
            if sidebar != nil { sidebar = nil }
            if columns != .detailOnly { columns = .detailOnly }
        }
    }

    func pageLoaded() {
        sidebarCheck?.cancel()
        guard sidebar != nil, !sidebarSeen else { return }
        sidebarCheck = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, !sidebarSeen, sidebar != nil else { return }
            sidebar = nil
            columns = .detailOnly
        }
    }

    func clear() {
        setChrome("null")
        sidebarCheck?.cancel()
        if sidebar != nil { sidebar = nil }
        sidebarFaces = [:]
        facesFresh = true
    }

    func present(kind: String, json: String) {
        let data = Data(json.utf8)
        let decoder = JSONDecoder()
        log.notice("present \(kind, privacy: .public)")
        do {
            switch kind {
            case "confirm": confirm(try decoder.decode(ConfirmRequest.self, from: data))
            case "message": showMessage(try decoder.decode(MessageMenuRequest.self, from: data))
            case "pictures": showPictures(try decoder.decode(PicturesRequest.self, from: data))
            case "toast": showToast(try decoder.decode(ToastRequest.self, from: data))
            default: break
            }
        } catch {
            log.error("present \(kind, privacy: .public) couldn't be read: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func coveredChanged(from was: Bool) {
        guard covered != was else { return }
        log.notice("\(self.covered ? "covered" : "shown", privacy: .public)")
        // The keys go to what opened over the conversation, not to the composer under it.
        if covered { shell?.focusPage() }
    }

    // MARK: To the page

    func send(_ event: [String: Any]) {
        shell?.dispatch("gond:native-chrome", event)
    }

    func sendSidebar(_ event: [String: Any]) {
        shell?.dispatch("gond:native-sidebar", event)
    }

    func dismissCover() {
        sendSidebar(["type": "dismiss"])
    }

    func focusSearch() {
        guard sidebar != nil else { return }
        if columns == .detailOnly { columns = .all }
        searchRequest += 1
    }

    private func answer(_ id: String, _ value: Any?) {
        shell?.dispatch("gond:native", ["id": id, "value": value ?? NSNull()])
    }

    // MARK: A confirm

    private func confirm(_ request: ConfirmRequest) {
        let alert = NSAlert()
        alert.messageText = request.title
        alert.informativeText = request.message
        alert.alertStyle = request.destructive ? .warning : .informational
        let action = alert.addButton(withTitle: request.action)
        action.hasDestructiveAction = request.destructive
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        let id = request.id
        guard let window = window ?? shell?.webView.window else {
            answer(id, false)
            return
        }
        alert.beginSheetModal(for: window) { [weak self] response in
            let yes = response == .alertFirstButtonReturn
            Task { @MainActor in self?.answer(id, yes) }
        }
    }

    // MARK: A toast

    private func showToast(_ request: ToastRequest) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { toast = request }
        toastTimer?.cancel()
        toastTimer = Task {
            try? await Task.sleep(for: .seconds(request.tone == "error" ? 4 : 2.5))
            guard !Task.isCancelled else { return }
            dismissToast(request.id)
        }
    }

    func dismissToast(_ id: String) {
        guard toast?.id == id else { return }
        withAnimation(.easeOut(duration: 0.25)) { toast = nil }
    }

    func notice(_ text: String) {
        showToast(ToastRequest(id: UUID().uuidString, title: text, description: "", tone: "error"))
    }

    // MARK: A message's menu

    private func showMessage(_ request: MessageMenuRequest) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let id = request.id
        let picker = MenuPicker { [weak self] pick in self?.answer(id, pick) }
        if let reactions = request.reactions, !reactions.options.isEmpty {
            for emoji in reactions.options {
                let item = NSMenuItem(title: emoji, action: #selector(MenuPicker.pick(_:)), keyEquivalent: "")
                item.target = picker
                item.representedObject = ["react": emoji]
                item.state = reactions.mine == emoji ? .on : .off
                menu.addItem(item)
            }
            if !request.items.isEmpty { menu.addItem(.separator()) }
        }
        for entry in request.items {
            let item = NSMenuItem(title: entry.label, action: #selector(MenuPicker.pick(_:)), keyEquivalent: "")
            item.target = picker
            item.representedObject = ["action": entry.id]
            item.image = NSImage(systemSymbolName: entry.symbol, accessibilityDescription: nil)
            if entry.destructive {
                item.attributedTitle = NSAttributedString(string: entry.label, attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuFont(ofSize: 0)])
            }
            menu.addItem(item)
        }
        guard let shell, !menu.items.isEmpty else { return answer(request.id, nil) }
        let rect = request.rect.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
        // Out of the page's message first: the menu runs its own loop until it closes.
        Task { @MainActor in
            _ = menu.popUp(positioning: nil, at: shell.menuPoint(for: rect), in: shell.webView)
            // An item's action may come just after the menu closes; nothing picked by then is a close.
            Task { @MainActor in picker.finish(nil) }
        }
    }

    // MARK: Quick Look

    private func showPictures(_ request: PicturesRequest) {
        guard !opening, preview == nil, !request.items.isEmpty else { return answer(request.id, nil) }
        opening = true
        Task {
            // Quick Look needs files; the pictures come with the web view's session.
            let index = min(max(0, request.index), request.items.count - 1)
            let lower = max(0, index - 20)
            let items = Array(request.items[lower..<min(request.items.count, index + 21)])
            var files = [URL?](repeating: nil, count: items.count)
            await withTaskGroup(of: (Int, URL?).self) { group in
                for (i, item) in items.enumerated() {
                    group.addTask { (i, await self.download(item)) }
                }
                for await (i, file) in group { files[i] = file }
            }
            opening = false
            log.notice("pictures: \(files.compactMap { $0 }.count, privacy: .public) of \(files.count, privacy: .public) downloaded")
            let wanted = index - lower
            guard wanted < files.count, files[wanted] != nil else {
                notice("Couldn't open that picture. Try again.")
                return answer(request.id, nil)
            }
            previewFiles = files.compactMap { $0 }
            picturesAsked = request.id
            preview = files[wanted]
        }
    }

    func previewPDF(_ file: URL) -> Bool {
        guard !opening, preview == nil else { return false }
        previewFiles = [file]
        preview = file
        return true
    }

    func selectPreview(_ url: URL?) {
        guard preview != url else { return }
        preview = url
        guard url == nil else { return }
        if let id = picturesAsked {
            picturesAsked = nil
            answer(id, nil)
        }
        // Quick Look still draws them while it fades; they go once it's long gone.
        let files = previewFiles
        Task {
            try? await Task.sleep(for: .seconds(30))
            for file in files { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        }
    }

    private func download(_ item: PicturesRequest.Item) async -> URL? {
        let data: Data
        do {
            guard let fetched = try await shell?.fetch(item.url) else { return nil }
            data = fetched
        } catch {
            log.error("picture \(item.url, privacy: .public) didn't download: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pictures/\(UUID().uuidString)", isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
        let name = item.name.replacingOccurrences(of: "/", with: "-")
        let file = folder.appendingPathComponent(name.isEmpty ? "picture" : name)
        return (try? data.write(to: file)) != nil ? file : nil
    }

    // MARK: Attaching

    /// The composer's paperclip: any file, since Gond keeps every type and the page decides how each shows.
    func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.prompt = "Attach"
        guard let window = window ?? shell?.webView.window else {
            if panel.runModal() == .OK { attach(panel.urls) }
            return
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { @MainActor in self?.attach(urls) }
        }
    }

    func attach(_ urls: [URL]) {
        let limit = 20 * 1024 * 1024
        var files: [[String: String]] = []
        var tooBig = false
        for url in urls where url.isFileURL {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if size > limit {
                tooBig = true
                continue
            }
            // Mapped, not read: a file is only measured before it goes.
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { continue }
            if data.count > limit {
                tooBig = true
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(["name": url.lastPathComponent, "type": type, "data": data.base64EncodedString()])
        }
        if tooBig { send(["type": "notice", "text": "A file over 20 MB was left out."]) }
        guard !files.isEmpty else { return }
        send(["type": "attach", "files": files])
    }

    func attachPicture(_ png: Data) {
        guard png.count <= 20 * 1024 * 1024 else {
            send(["type": "notice", "text": "A file over 20 MB was left out."])
            return
        }
        send(["type": "attach", "files": [["name": "Pasted picture.png", "type": "image/png", "data": png.base64EncodedString()]]])
    }

    static func image(dataURL: String) -> NSImage? {
        guard let comma = dataURL.firstIndex(of: ","), let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }
}

@MainActor
private final class MenuPicker: NSObject {
    private var done = false
    private let answer: @MainActor ([String: String]?) -> Void

    init(answer: @escaping @MainActor ([String: String]?) -> Void) {
        self.answer = answer
    }

    @objc func pick(_ sender: NSMenuItem) {
        finish(sender.representedObject as? [String: String])
    }

    func finish(_ pick: [String: String]?) {
        guard !done else { return }
        done = true
        answer(pick)
    }
}
