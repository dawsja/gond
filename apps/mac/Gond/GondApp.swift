import AppKit
import QuickLook
import SwiftUI

@main
struct GondApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    init() {
        // Ready before anything else, so a click on a notification that launched the app isn't missed.
        _ = Notifications.shared
    }

    var body: some Scene {
        Window("Gond", id: "main") {
            RootView(model: model, ui: model.ui)
                .onAppear { delegate.model = model }
        }
        .defaultSize(Self.windowSize)
        // The one window opens at every launch, whatever state the last run left.
        .defaultLaunchBehavior(.presented)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { GondCommands(model: model, ui: model.ui) }
    }

    private static var windowSize: CGSize {
        #if DEBUG
        if Screens.active { return CGSize(width: 1440, height: 900) }
        #endif
        return CGSize(width: 1280, height: 820)
    }
}

/// Closing the window keeps Gond running, so its notices still come; the Dock icon brings it back.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationWillFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let look = Screens.appearance { NSApp.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua) }
        #endif
    }

    #if DEBUG
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard Screens.active else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            let shown = NSApp.windows.filter(\.isVisible).map { "\($0.identifier?.rawValue ?? "?") \(NSStringFromRect($0.frame))" }
            Screens.note("windows: \(shown.joined(separator: "; ")), screen \(NSStringFromRect(NSScreen.main?.frame ?? .zero)) visible \(NSStringFromRect(NSScreen.main?.visibleFrame ?? .zero))")
        }
    }
    #endif

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { model?.reopen?() }
        return true
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var ui: NativeUI
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ZStack {
            if model.screen == .connect {
                ConnectView(model: model).transition(.opacity)
            } else {
                MainView(model: model, ui: ui)
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        // Connect's toolbar holds nothing, so it draws no background or line under the title bar either.
        // (Hiding the toolbar would take the window's close and zoom buttons with it.)
        .toolbarBackgroundVisibility(model.screen == .connect ? .hidden : .automatic, for: .windowToolbar)
        .animation(.easeOut(duration: 0.2), value: model.screen)
        .background(WindowReader { window in model.attach(window) })
        // SwiftUI's own Quick Look, the panel Finder uses, swiping through what the page sent.
        .quickLookPreview(Binding(get: { ui.preview }, set: { ui.selectPreview($0) }), in: ui.previewFiles)
        .onAppear {
            let open = openWindow
            model.reopen = { open(id: "main") }
            model.start()
        }
    }
}

/// Hands the window this view is in to the model, which colours it and anchors sheets on it.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow) -> Void

    func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.found = found
        return view
    }

    func updateNSView(_ view: ReaderView, context: Context) {
        view.found = found
        if let window = view.window { found(window) }
    }

    final class ReaderView: NSView {
        var found: ((NSWindow) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { found?(window) }
        }
    }
}

/// The menu bar: Settings and Change server in the app's menu, New bot in File, Search in View.
/// While something of the page's is open over the conversation, none of them go.
struct GondCommands: Commands {
    @ObservedObject var model: AppModel
    @ObservedObject var ui: NativeUI

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.openSettings() }
                .keyboardShortcut(",", modifiers: .command)
                .disabled(!model.shortcutsWork)
            Button("Change server…") { model.showConnect() }
                .disabled(model.screen != .web)
        }
        CommandGroup(replacing: .newItem) {
            Button("New bot") { model.newBot() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(!model.shortcutsWork || ui.sidebar == nil)
        }
        CommandGroup(before: .sidebar) {
            Button("Search") { ui.focusSearch() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(!model.shortcutsWork || ui.sidebar == nil || ui.sidebar?.settings == true)
        }
        CommandGroup(replacing: .help) {}
    }
}
