import Combine
import PhotosUI
import QuickLook
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
    let composer: Composer
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

@MainActor
final class NativeUI: ObservableObject {
    struct MessageMenu: Identifiable {
        let id: String
        let request: MessageMenuRequest
        let snapshot: UIImage?
    }

    @Published private(set) var chrome: ChromeState?
    @Published private(set) var faces: [UIImage] = []
    @Published private(set) var message: MessageMenu?
    @Published private(set) var opening = false

    weak var shell: WebShell?
    private var faceSources: [String] = []
    private var pictures: PicturesSession?
    private var attaching: AttachPicker?

    // MARK: From the page

    func setChrome(_ json: String) {
        guard json != "null", let state = try? JSONDecoder().decode(ChromeState.self, from: Data(json.utf8)) else {
            if chrome != nil { chrome = nil }
            shell?.setComposerMetrics(nil)
            return
        }
        if state.faces != faceSources {
            faceSources = state.faces
            faces = state.faces.compactMap(Self.image(dataURL:))
        }
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
        switch kind {
        case "confirm":
            if let request = try? decoder.decode(ConfirmRequest.self, from: data) { confirm(request) }
        case "message":
            if let request = try? decoder.decode(MessageMenuRequest.self, from: data) { showMessage(request) }
        case "pictures":
            if let request = try? decoder.decode(PicturesRequest.self, from: data) { showPictures(request) }
        default:
            break
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

    // MARK: A message's menu

    private func showMessage(_ request: MessageMenuRequest) {
        if let message { finishMessage(nil, id: message.id) }
        let rect = CGRect(x: request.rect.x, y: request.rect.y, width: request.rect.width, height: request.rect.height)
        Task {
            let snapshot = await shell?.snapshot(rect)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                message = MessageMenu(id: request.id, request: request, snapshot: snapshot)
            }
        }
    }

    func finishMessage(_ pick: [String: String]?, id: String) {
        guard message?.id == id else { return }
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
            let wanted = index - lower
            guard wanted < files.count, files[wanted] != nil, let top = UIApplication.shared.topViewController else {
                UIApplication.shared.topViewController?.showNotice("Couldn't open that picture. Try again.")
                return answer(request.id, nil)
            }
            let shown = files.compactMap { $0 }
            let start = files[..<wanted].compactMap { $0 }.count
            let session = PicturesSession(files: shown) { [weak self] in
                self?.pictures = nil
                self?.answer(request.id, nil)
            }
            pictures = session
            let viewer = QLPreviewController()
            viewer.dataSource = session
            viewer.delegate = session
            viewer.currentPreviewItemIndex = start
            top.present(viewer, animated: true)
        }
    }

    private func download(_ item: PicturesRequest.Item) async -> URL? {
        guard let data = try? await shell?.fetch(item.url) else { return nil }
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

/// Quick Look over the downloaded pictures; it answers the page when the person closes it.
private final class PicturesSession: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private let files: [URL]
    private let done: @MainActor () -> Void

    init(files: [URL], done: @escaping @MainActor () -> Void) {
        self.files = files
        self.done = done
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        files.count
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        files[index] as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        let files = files
        Task { @MainActor in
            for file in files { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            done()
        }
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
            await done(files)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let files = urls.compactMap { url -> File? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return File(name: url.lastPathComponent, type: type, data: data)
        }
        Task { await done(files) }
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
