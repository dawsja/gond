import SwiftUI

/// Your Gond in the window: the app's sidebar beside the page, the toolbar over it and the composer on it.
struct MainView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var ui: NativeUI

    var body: some View {
        NavigationSplitView(columnVisibility: $ui.columns) {
            SidebarView(ui: ui)
                .navigationSplitViewColumnWidth(min: 240, ideal: 290, max: 420)
        } detail: {
            DetailView(model: model, ui: ui)
        }
        .environment(\.chromeScale, ui.scale)
    }
}

/// The page, under the window's toolbar when it has the Mac's layout, with the app's composer on it.
struct DetailView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var ui: NativeUI

    var body: some View {
        GeometryReader { proxy in
            let toolbar = proxy.safeAreaInsets.top
            // Only a page that draws for the Mac (it sends the sidebar) pads its top for the toolbar;
            // anything else starts below it.
            let under = ui.sidebar != nil
            ZStack(alignment: .top) {
                Color(nsColor: model.pageBackground ?? .windowBackgroundColor)
                WebContainer(shell: model.shell)
                    .padding(.top, under ? 0 : toolbar)
                if let chrome = ui.chrome {
                    ComposerLayer(ui: ui, state: chrome, width: proxy.size.width)
                        .id(chrome.thread)
                        .transition(.opacity)
                }
                if model.progress < 1 {
                    LoadingBar(progress: model.progress)
                        .padding(.top, toolbar)
                        .allowsHitTesting(false)
                }
                if let toast = ui.toast {
                    ToastView(toast: toast) { ui.dismissToast(toast.id) }
                        .id(toast.id)
                        .padding(.top, toolbar + 10)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .zIndex(4)
                }
                if ui.opening {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Opening the picture").font(.system(size: 13, weight: .medium))
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .glassControl(in: Capsule(), interactive: false)
                    .frame(maxHeight: .infinity)
                    .transition(.opacity)
                    .zIndex(3)
                }
            }
            .animation(.easeOut(duration: 0.2), value: ui.chrome?.thread)
            .onChange(of: under ? toolbar : 0, initial: true) { _, inset in model.shell.setInsetTop(inset) }
        }
        .ignoresSafeArea(.container, edges: .top)
        .toolbarMaterial()
        .navigationTitle(ui.chrome?.title ?? ui.sidebar?.title ?? "Gond")
        .toolbar {
            ToolbarItem(placement: .navigation) {
                TitleView(ui: ui)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                if let chrome = ui.chrome {
                    ForEach(chrome.screens) { screen in
                        Button { ui.send(["type": "screen", "id": screen.id]) } label: {
                            Label(screen.label, systemImage: "display")
                        }
                        .labelStyle(.titleAndIcon)
                        .help("Show \(screen.label)")
                        .disabled(ui.covered)
                    }
                    Button { ui.send(["type": "details"]) } label: {
                        Label("Details", systemImage: "sidebar.right")
                    }
                    .help("Details")
                    .disabled(ui.covered)
                    .accessibilityIdentifier("chrome.details")
                    if !chrome.menu.isEmpty {
                        Menu {
                            ForEach(Array(chrome.menu.enumerated()), id: \.offset) { _, group in
                                Section {
                                    ForEach(group) { item in
                                        Button(role: item.destructive ? .destructive : nil) {
                                            ui.send(["type": "menu", "id": item.id])
                                        } label: {
                                            Label(item.label, systemImage: item.symbol)
                                        }
                                    }
                                }
                            }
                        } label: {
                            Label("More", systemImage: "ellipsis")
                        }
                        .menuIndicator(.hidden)
                        .help("More")
                        .disabled(ui.covered)
                        .accessibilityIdentifier("chrome.more")
                    }
                }
            }
        }
    }
}

/// The toolbar's start: the conversation's faces, name and what the bot is doing, which open its
/// details; elsewhere the page's title (a Settings section, or Gond).
private struct TitleView: View {
    @ObservedObject var ui: NativeUI

    var body: some View {
        if let chrome = ui.chrome {
            Button { ui.send(["type": "details"]) } label: {
                HStack(spacing: 8) {
                    FacesView(faces: ui.faces, more: chrome.more, primary: chrome.primary, space: chrome.space)
                        .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(chrome.title)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        if !chrome.subtitle.isEmpty {
                            Subtitle(text: chrome.subtitle, working: chrome.working)
                        }
                    }
                    if chrome.working {
                        ProgressView().controlSize(.mini).accessibilityLabel("Working")
                    }
                }
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // While something of the page's is open over the conversation, its toolbar waits under it.
            .disabled(ui.covered)
            .opacity(ui.covered ? 0.4 : 1)
            .accessibilityLabel("\(chrome.title)'s details")
            .accessibilityIdentifier("chrome.title")
        } else {
            Text(ui.sidebar?.title ?? "Gond")
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .padding(.horizontal, 4)
        }
    }
}

/// "Systems Administrator · working", breathing while a bot works, as the page's shimmer does.
private struct Subtitle: View {
    let text: String
    let working: Bool

    var body: some View {
        let line = Text(text).font(.system(size: 11)).lineLimit(1)
        if working {
            line.phaseAnimator([0.8, 0.35]) { content, phase in content.opacity(phase) } animation: { _ in .easeInOut(duration: 0.9) }
        } else {
            line.opacity(0.7)
        }
    }
}

/// A bot's face, or a room's two on the diagonal with a +N for the rest, the primary bot's crown, and a space's globe on the top corner as on the page.
struct FacesView: View {
    let faces: [NSImage]
    let more: Int
    let primary: Bool
    var space = false

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size.width
            ZStack(alignment: .topLeading) {
                if faces.count >= 2 {
                    face(faces[1]).frame(width: size * 0.68, height: size * 0.68)
                    face(faces[0]).frame(width: size * 0.68, height: size * 0.68).offset(x: size * 0.32, y: size * 0.32)
                } else if let first = faces.first {
                    face(first).frame(width: size, height: size)
                } else {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: size * 0.45))
                        .foregroundStyle(Theme.muted)
                        .frame(width: size, height: size)
                }
                if more > 0 {
                    Text("+\(more)")
                        .font(.system(size: max(8, size * 0.26), weight: .semibold).monospacedDigit())
                        .padding(.horizontal, 3)
                        .background(Capsule().fill(.regularMaterial))
                        .offset(x: -2, y: size * 0.66)
                }
                if primary {
                    Image(systemName: "crown.fill")
                        .font(.system(size: size * 0.2))
                        .foregroundStyle(Color(hex: 0x5A4100))
                        .frame(width: size * 0.42, height: size * 0.42)
                        .background(Circle().fill(Color(hex: 0xF2C14E)))
                        .offset(x: size * 0.6, y: size * 0.6)
                }
                if space {
                    Image(systemName: "globe")
                        .font(.system(size: size * 0.26, weight: .semibold))
                        .foregroundStyle(Theme.background)
                        .frame(width: size * 0.42, height: size * 0.42)
                        .background(Circle().fill(Theme.foreground))
                        .offset(x: size * 0.64, y: -size * 0.06)
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func face(_ image: NSImage) -> some View {
        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
    }
}

/// How far a page has loaded, a hairline under the toolbar.
private struct LoadingBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { proxy in
            Rectangle()
                .fill(Theme.foreground.opacity(0.7))
                .frame(width: proxy.size.width * max(0.05, min(1, progress)), height: 2)
        }
        .frame(height: 2)
        .animation(.easeOut(duration: 0.2), value: progress)
    }
}

/// A glass capsule at the top of the page: a tick, an i or a warning, the title and a line under it.
struct ToastView: View {
    let toast: ToastRequest
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.tone == "error" ? "exclamationmark.triangle.fill" : toast.tone == "success" ? "checkmark.circle.fill" : "info.circle.fill")
                .foregroundStyle(toast.tone == "error" ? Theme.destructive : toast.tone == "success" ? Color(hex: 0x2E9E5B) : Theme.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(toast.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                if !toast.description.isEmpty {
                    Text(toast.description).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(3)
                }
            }
        }
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: 380)
        .glassControl(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .onTapGesture(perform: dismiss)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .padding(.horizontal, 16)
    }
}

private extension View {
    /// The page scrolls under the toolbar: glass keeps it readable from macOS 26, the toolbar's own material before.
    @ViewBuilder
    func toolbarMaterial() -> some View {
        if #available(macOS 26.0, *) {
            self
        } else {
            toolbarBackground(.visible, for: .windowToolbar)
        }
    }
}
