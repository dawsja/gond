import SwiftUI
import WebKit

@main
struct GondApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Ready before anything else, so a tap on a notification that launched the app isn't missed.
        _ = Notifications.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            (model.pageBackground ?? Theme.background).ignoresSafeArea()
            WebContainer(shell: model.shell)
                .ignoresSafeArea()
                .opacity(model.screen == .web ? 1 : 0)
            if model.screen == .web && model.progress < 1 {
                ProgressView(value: model.progress)
                    .progressViewStyle(.linear)
                    .tint(Theme.foreground)
                    .frame(height: 2)
            }
            if model.screen == .connect {
                ConnectView(model: model).transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.screen)
        .preferredColorScheme(scheme)
        .onAppear { model.start() }
    }
}

extension RootView {
    /// The page's own theme while it shows, so the status bar reads on it; the system's on Connect.
    var scheme: ColorScheme? {
        guard model.screen == .web, let dark = model.pageDark else { return nil }
        return dark ? .dark : .light
    }
}

/// The web view, filling the window under the status bar; it tells the page how much of it the bars cover.
struct WebContainer: UIViewRepresentable {
    let shell: WebShell

    func makeUIView(context: Context) -> InsetsView {
        let view = InsetsView()
        view.shell = shell
        shell.webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shell.webView)
        NSLayoutConstraint.activate([
            shell.webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shell.webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            shell.webView.topAnchor.constraint(equalTo: view.topAnchor),
            shell.webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        return view
    }

    func updateUIView(_ uiView: InsetsView, context: Context) {}

    final class InsetsView: UIView {
        weak var shell: WebShell?

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            shell?.pushInsets(safeAreaInsets)
        }
    }
}
