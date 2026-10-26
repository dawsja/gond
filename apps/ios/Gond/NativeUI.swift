import Combine
import os
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/*
 * What the app draws itself over your Gond's pages, in Liquid Glass (apps/web/lib/native-ui.ts):
 * a destructive confirm, a message's long-press menu, the pictures in Quick Look, and a
 * conversation's header and composer. The page asks with `present` and hears the answer as a
 * `gond:native` event; the chrome comes in as state with `chrome` and goes back as
 * `gond:native-chrome` events. Everything here acts only through those events, so the page stays
 * the one that decides what happens.
 */

struct ChromeState: Decodable, Equatable {
    struct Item: Decodable, Equatable, Identifiable {
        let id: String
        let label: String
        let symbol: String
        let destructive: Bool?
    }

    struct Composer: Decodable, Equatable {
        let text: String
        let textRev: Int
        let focusRev: Int
        let placeholder: String
        let canSend: Bool
        let sending: Bool
        let later: Bool
        let voice: String
        let seconds: Int
    }

    struct Mention: Decodable, Equatable, Identifiable {
        let id: String
        let handle: String
        let face: String?
    }

    struct File: Decodable, Equatable {
        let name: String
        let size: String
    }

    struct Replying: Decodable, Equatable {
        let name: String
        let color: String
        let text: String
    }

    struct Screen: Decodable, Equatable, Identifiable {
        let id: String
        let label: String
    }

    /// A call with the bot, which takes the composer's place: what is happening, since when, and the bot's colour.
    struct Call: Decodable, Equatable {
        let label: String
        /// When it was picked up, in milliseconds since 1970, so the clock ticks here.
        let since: Double
        let connecting: Bool
        let muted: Bool
        let speaking: Bool
        let color: String
    }

    let thread: String
    let title: String
    let subtitle: String
    let working: Bool
    let faces: [String]
    let more: Int
    let primary: Bool
    let tint: String
    let menu: [[Item]]
    let covered: Bool
    // Newer pages send these; an older server's page doesn't, and the composer goes without them.
    let space: Bool?
    let mentions: [Mention]?
    let files: [File]?
    let replying: Replying?
    let jump: Bool?
    let screens: [Screen]?
    let call: Call?
    let composer: Composer
}

/// The Chats screen's header: your picture, Search and New.
struct ChatsState: Decodable, Equatable {
    let searching: Bool?
    let face: String?
    let initial: String
    let canNewRoom: Bool
    let covered: Bool
}

/// A Settings page's back button.
struct SettingsState: Decodable, Equatable {
    let label: String
    let covered: Bool
}

struct ToastRequest: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let description: String
    let tone: String
}

struct MessageMenuRequest: Decodable {
    struct Rect: Decodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    struct Reactions: Decodable {
        let options: [String]
        let mine: String?
    }

    struct Item: Decodable, Identifiable {
        let id: String
        let label: String
        let symbol: String
        let destructive: Bool?
    }

    let id: String
    let rect: Rect
    let mine: Bool
    let reactions: Reactions?
    let items: [Item]
    /// How the lifted copy is cut: a bubble (nil), a chat row, or a pinned bot's face.
    let shape: String?
}

private struct ConfirmRequest: Decodable {
    let id: String
    let title: String
    let message: String
    let action: String
    let destructive: Bool
}

private struct PicturesRequest: Decodable {
    struct Item: Decodable {
        let url: String
        let name: String
    }

    let id: String
    let items: [Item]
    let index: Int
}

private let log = Logger(subsystem: "io.gond.ios", category: "native")

@MainActor
final class NativeUI: ObservableObject {
    struct MessageMenu: Identifiable {
        let id: String
        let request: MessageMenuRequest
        let snapshot: UIImage?
    }

    @Published private(set) var chrome: ChromeState?
    @Published private(set) var chats: ChatsState?
    @Published private(set) var chatsFace: UIImage?
    @Published private(set) var settings: SettingsState?
    @Published private(set) var toast: ToastRequest?
    /// The room's faces for the @mention chips, by bot id.
    @Published private(set) var mentionFaces: [String: UIImage] = [:]
    private var mentionSources: [String: String] = [:]
    private var toastTimer: Task<Void, Never>?
    @Published private(set) var faces: [UIImage] = []
    @Published private(set) var message: MessageMenu?
    @Published private(set) var opening = false
    /// The picture Quick Look shows, and the ones it swipes through.
    @Published private(set) var picture: URL?
    @Published private(set) var pictureFiles: [URL] = []
    private var picturesAsked: String?

    weak var shell: WebShell?
    private var faceSources: [String] = []
    private var attaching: AttachPicker?

    // MARK: From the page

    func setChrome(_ json: String) {
        struct Screen: Decodable { let screen: String? }
        let data = Data(json.utf8)
        let screen = (try? JSONDecoder().decode(Screen.self, from: data))?.screen
        if screen == "settings", let state = try? JSONDecoder().decode(SettingsState.self, from: data) {
            if chrome != nil { chrome = nil }
            if chats != nil { chats = nil }
            if state != settings { settings = state }
            return
        }
        if settings != nil { settings = nil }
        if screen == "chats", let state = try? JSONDecoder().decode(ChatsState.self, from: data) {
            if chrome != nil { chrome = nil }
            if state.face != chats?.face { chatsFace = state.face.flatMap(Self.image(dataURL:)) }
            if state != chats { chats = state }
            return
        }
        if chats != nil { chats = nil }
        guard json != "null", let state = try? JSONDecoder().decode(ChromeState.self, from: data) else {
            if chrome != nil { chrome = nil }
            shell?.setComposerMetrics(nil)
            return
        }
        if state.faces != faceSources {
            faceSources = state.faces
            faces = state.faces.compactMap(Self.image(dataURL:))
        }
        let sources = Dictionary((state.mentions ?? []).compactMap { m in m.face.map { (m.id, $0) } }, uniquingKeysWith: { a, _ in a })
        if sources != mentionSources {
            mentionSources = sources
            mentionFaces = sources.compactMapValues(Self.image(dataURL:))
        }
        if state.covered != chrome?.covered { log.notice("chrome \(state.covered ? "covered" : "shown", privacy: .public)") }
        if state != chrome { chrome = state }
    }

    /// A new page, or another site's, has none of this.
    func clear() {
        setChrome("null")
        if let message { finishMessage(nil, id: message.id) }
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

    // MARK: To the page

    func send(_ event: [String: Any]) {
        shell?.dispatch("gond:native-chrome", event)
    }

    private func answer(_ id: String, _ value: Any?) {
        shell?.dispatch("gond:native", ["id": id, "value": value ?? NSNull()])
    }

    // MARK: A confirm

    /// iOS's own alert, which is Liquid Glass from iOS 26.
    private func confirm(_ request: ConfirmRequest) {
        guard let top = UIApplication.shared.topViewController else { return answer(request.id, false) }
        let alert = UIAlertController(title: request.title, message: request.message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            Task { @MainActor in self?.answer(request.id, false) }
        })
        alert.addAction(UIAlertAction(title: request.action, style: request.destructive ? .destructive : .default) { [weak self] _ in
            Task { @MainActor in self?.answer(request.id, true) }
        })
        top.present(alert, animated: true)
    }

    // MARK: A toast

    /// A glass capsule at the top for a few seconds; a tap puts it away sooner.
    private func showToast(_ request: ToastRequest) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { toast = request }
        if request.tone == "error" { UINotificationFeedbackGenerator().notificationOccurred(.error) }
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

    // MARK: A message's menu

    private func showMessage(_ request: MessageMenuRequest) {
        if let message { finishMessage(nil, id: message.id) }
        let rect = CGRect(x: request.rect.x, y: request.rect.y, width: request.rect.width, height: request.rect.height)
        Task {
            let snapshot = await shell?.snapshot(rect)
            // The finger that held the bubble is still down on the web view: cancel its touch there,
            // or WebKit is left mid-gesture and drops the next tap after the menu goes.
            shell?.webView.isUserInteractionEnabled = false
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                message = MessageMenu(id: request.id, request: request, snapshot: snapshot)
            }
        }
    }

    func finishMessage(_ pick: [String: String]?, id: String) {
        guard message?.id == id else { return }
        shell?.webView.isUserInteractionEnabled = true
        withAnimation(.easeOut(duration: 0.18)) { message = nil }
        answer(id, pick)
    }

    // MARK: Pictures

    private func showPictures(_ request: PicturesRequest) {
        guard !opening, !request.items.isEmpty else { return answer(request.id, nil) }
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
                UIApplication.shared.topViewController?.showNotice("Couldn't open that picture. Try again.")
                return answer(request.id, nil)
            }
            pictureFiles = files.compactMap { $0 }
            log.notice("quick look opens \(self.pictureFiles.count, privacy: .public) pictures, \((try? Data(contentsOf: files[wanted]!).count) ?? -1, privacy: .public) bytes shown")
            picturesAsked = request.id
            picture = files[wanted]
        }
    }

    /// Quick Look moved to another picture, or closed (nil), which answers the page.
    func showPicture(_ url: URL?) {
        log.notice("quick look shows \(url?.lastPathComponent ?? "nothing", privacy: .public)")
        picture = url
        guard url == nil, let id = picturesAsked else { return }
        picturesAsked = nil
        answer(id, nil)
        // Quick Look still draws them while it slides away; they go once it's long gone.
        let files = pictureFiles
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

    func pickPhotos() {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 10
        let picker = PHPickerViewController(configuration: configuration)
        let session = AttachPicker { [weak self] files in self?.attach(files) }
        attaching = session
        picker.delegate = session
        UIApplication.shared.topViewController?.present(picker, animated: true)
    }

    func pickFiles() {
        let types: [UTType] = [.image, .pdf, .plainText, .commaSeparatedText, .json, .text]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = true
        let session = AttachPicker { [weak self] files in self?.attach(files) }
        attaching = session
        picker.delegate = session
        UIApplication.shared.topViewController?.present(picker, animated: true)
    }

    private func attach(_ files: [AttachPicker.File]) {
        attaching = nil
        let limit = 20 * 1024 * 1024
        let fitting = files.filter { $0.data.count <= limit }
        if fitting.count < files.count { send(["type": "notice", "text": "A file over 20 MB was left out."]) }
        guard !fitting.isEmpty else { return }
        send(["type": "attach", "files": fitting.map { ["name": $0.name, "type": $0.type, "data": $0.data.base64EncodedString()] }])
    }

    private static func image(dataURL: String) -> UIImage? {
        guard let comma = dataURL.firstIndex(of: ","), let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return UIImage(data: data, scale: 3)
    }
}

/// The photo library or Files, for the composer's +; what comes back goes to the page as its own files.
private final class AttachPicker: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    struct File {
        let name: String
        let type: String
        let data: Data
    }

    private let done: @MainActor ([File]) -> Void

    init(done: @escaping @MainActor ([File]) -> Void) {
        self.done = done
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let providers = results.map(\.itemProvider)
        Task {
            var files: [File] = []
            for provider in providers {
                if let file = await Self.load(provider) { files.append(file) }
            }
            done(files)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let files = urls.compactMap { url -> File? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return File(name: url.lastPathComponent, type: type, data: data)
        }
        Task { done(files) }
    }

    /// A GIF or PNG as it is (a GIF keeps moving); anything else, HEIC included, as a JPEG every browser and bot can read.
    private static func load(_ provider: NSItemProvider) async -> File? {
        let name = provider.suggestedName ?? "Photo"
        for (type, mime, ext) in [(UTType.gif, "image/gif", "gif"), (UTType.png, "image/png", "png")] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            if let data = await data(provider, type) { return File(name: "\(name).\(ext)", type: mime, data: data) }
        }
        let image: UIImage? = await withCheckedContinuation { continuation in
            guard provider.canLoadObject(ofClass: UIImage.self) else { return continuation.resume(returning: nil) }
            provider.loadObject(ofClass: UIImage.self) { object, _ in continuation.resume(returning: object as? UIImage) }
        }
        guard let jpeg = image?.jpegData(compressionQuality: 0.9) else { return nil }
        return File(name: "\(name).jpg", type: "image/jpeg", data: jpeg)
    }

    private static func data(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in continuation.resume(returning: data) }
        }
    }
}
