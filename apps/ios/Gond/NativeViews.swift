import Combine
import SwiftUI
import UIKit

/// The app's own layer over the web view: a conversation's header and composer, a message's menu, and the wait while pictures open.
struct NativeLayer: View {
    @ObservedObject var ui: NativeUI

    var body: some View {
        ZStack {
            if let chrome = ui.chrome {
                ChromeView(ui: ui, state: chrome)
                    .id(chrome.thread)
                    .opacity(chrome.covered ? 0 : 1)
                    .allowsHitTesting(!chrome.covered)
                    .animation(.easeOut(duration: 0.15), value: chrome.covered)
                    .transition(.opacity)
            }
            if let message = ui.message {
                MessageMenuView(menu: message) { pick in ui.finishMessage(pick, id: message.id) }
                    .transition(.opacity)
                    .zIndex(2)
            }
            if ui.opening {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Opening the picture").font(.system(size: 15, weight: .medium))
                }
                .padding(.horizontal, 18)
                .frame(height: 48)
                .glassControl(in: Capsule())
                .transition(.opacity)
                .zIndex(3)
            }
        }
        .animation(.easeOut(duration: 0.2), value: ui.chrome?.thread)
    }
}

// MARK: A conversation's header and composer

struct ChromeView: View {
    @ObservedObject var ui: NativeUI
    let state: ChromeState

    @State private var text = ""
    @State private var appliedRev = -1
    /// The page's text just put in the field, which isn't sent back to it.
    @State private var applied: String?
    @State private var keyboard: CGFloat = 0
    @State private var fieldHeight: CGFloat = 44
    @FocusState private var focused: Bool

    var body: some View {
        // Laid out over the whole screen from the window's own insets, as the page lays out its
        // header and composer, so the two match to the point; the reader redraws it on a rotation.
        GeometryReader { _ in
            let insets = UIApplication.shared.windowInsets
            let bottom = composerBottom(safeBottom: insets.bottom)
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 12)
                    .frame(height: 64)
                Spacer(minLength: 0)
                composer
                    .padding(.horizontal, 12)
                    // A field of the page's own is being typed in; the keyboard covers this one anyway.
                    .opacity(keyboard > 0 && !focused ? 0 : 1)
            }
            .padding(.top, insets.top)
            .padding(.bottom, bottom)
            .onChange(of: bottom) { push(bottom: bottom) }
            .onChange(of: fieldHeight) { push(bottom: bottom) }
            .onAppear { push(bottom: bottom) }
        }
        .ignoresSafeArea()
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let height = max(0, UIApplication.shared.windowBounds.height - frame.minY)
            withAnimation(.easeOut(duration: 0.25)) { keyboard = height }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.easeOut(duration: 0.25)) { keyboard = 0 }
        }
        .onAppear(perform: applyPageText)
        .onChange(of: state.composer.textRev) { applyPageText() }
        .onChange(of: state.composer.focusRev) { focused = true }
        .onChange(of: text) {
            if text == applied {
                applied = nil
                return
            }
            ui.send(["type": "text", "value": text])
        }
    }

    /// From the screen's bottom edge to the composer's, as the page's own would sit: clear of the
    /// home indicator, or 12 points over the keyboard while this field has it.
    private func composerBottom(safeBottom: CGFloat) -> CGFloat {
        focused && keyboard > 0 ? keyboard + 12 : max(12, safeBottom)
    }

    private func push(bottom: CGFloat) {
        ui.shell?.setComposerMetrics((bottom: bottom, height: fieldHeight))
    }

    private func applyPageText() {
        guard state.composer.textRev > appliedRev else { return }
        appliedRev = state.composer.textRev
        guard text != state.composer.text else { return }
        applied = state.composer.text
        text = state.composer.text
    }

    private var tint: Color {
        UIColor(css: state.tint).map { Color(uiColor: $0) } ?? Theme.tint
    }

    private var header: some View {
        GlassGroup {
            HStack(spacing: 8) {
                Button { ui.send(["type": "back"]) } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassControl(in: Circle())
                .accessibilityLabel("Back to chats")
                .accessibilityIdentifier("chrome.back")

                Button { ui.send(["type": "details"]) } label: {
                    HStack(spacing: 8) {
                        FacesView(faces: ui.faces, more: state.more, primary: state.primary)
                            .frame(width: 32, height: 32)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(state.title)
                                .font(.system(size: 15, weight: .semibold))
                                .lineLimit(1)
                            Subtitle(text: state.subtitle, working: state.working)
                        }
                    }
                    .padding(.leading, 6)
                    .padding(.trailing, 16)
                    .frame(height: 44)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .glassControl(in: Capsule())
                .accessibilityLabel("\(state.title)'s details")
                .accessibilityIdentifier("chrome.details")

                Spacer(minLength: 0)

                if !state.menu.isEmpty {
                    Menu {
                        ForEach(Array(state.menu.enumerated()), id: \.offset) { _, group in
                            Section {
                                ForEach(group) { item in
                                    Button(role: item.destructive == true ? .destructive : nil) {
                                        ui.send(["type": "menu", "id": item.id])
                                    } label: {
                                        Label(item.label, systemImage: item.symbol)
                                    }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .glassControl(in: Circle())
                    .accessibilityLabel("More")
                    .accessibilityIdentifier("chrome.more")
                }
            }
            .foregroundStyle(Theme.foreground)
        }
    }

    private var composer: some View {
        GlassGroup {
            HStack(alignment: .bottom, spacing: 10) {
                Menu {
                    Button { ui.pickPhotos() } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                    Button { ui.pickFiles() } label: { Label("Files", systemImage: "folder") }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassControl(in: Circle())
                .accessibilityLabel("Attach files")
                .accessibilityIdentifier("chrome.attach")

                HStack(alignment: .bottom, spacing: 2) {
                    TextField(state.composer.placeholder, text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .font(.system(size: 16))
                        .focused($focused)
                        .padding(.leading, 16)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("chrome.field")
                    trailing
                        .padding(.trailing, 6)
                        .padding(.bottom, 6)
                }
                .frame(minHeight: 44)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fieldHeight = $0 }
                .glassControl(in: RoundedRectangle(cornerRadius: 22, style: .continuous), interactive: false)
            }
            .foregroundStyle(Theme.foreground)
        }
    }

    @ViewBuilder
    private var trailing: some View {
        let composer = state.composer
        HStack(spacing: 2) {
            if composer.later {
                Button("Later") { ui.send(["type": "send", "later": true]) }
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .accessibilityLabel("Send after it finishes")
            }
            if composer.voice == "recording" {
                Text("\(composer.seconds / 60):\(composer.seconds % 60 < 10 ? "0" : "")\(composer.seconds % 60)")
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 4)
            }
            Button { ui.send(["type": "voice"]) } label: {
                Group {
                    if composer.voice == "working" {
                        ProgressView()
                    } else {
                        Image(systemName: composer.voice == "recording" ? "stop.fill" : "mic")
                            .font(.system(size: 16, weight: .medium))
                    }
                }
                .frame(width: 32, height: 32)
                .background(Circle().fill(composer.voice == "recording" ? Theme.foreground.opacity(0.12) : .clear))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .opacity(composer.voice == "off" ? 0.45 : 1)
            .disabled(composer.voice == "working")
            .accessibilityLabel(composer.voice == "recording" ? "Stop and turn it into text" : "Talk instead of typing")

            Button { ui.send(["type": "send"]) } label: {
                Group {
                    if composer.sending {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Circle().fill(tint))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .opacity(composer.canSend ? 1 : 0.4)
            .disabled(!composer.canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("chrome.send")
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

/// A bot's face, or a room's two on the diagonal with a +N for the rest, and the primary bot's crown.
struct FacesView: View {
    let faces: [UIImage]
    let more: Int
    let primary: Bool

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
                        .font(.system(size: max(9, size * 0.26), weight: .semibold).monospacedDigit())
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
            }
        }
        .accessibilityHidden(true)
    }

    private func face(_ image: UIImage) -> some View {
        Image(uiImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
    }
}

// MARK: A message's menu

/// Like a long press in Messages: the page dims and blurs, the bubble lifts, the reactions sit above it in a glass capsule and the actions below.
struct MessageMenuView: View {
    let menu: NativeUI.MessageMenu
    let pick: ([String: String]?) -> Void
    @State private var lifted = false

    private var request: MessageMenuRequest { menu.request }
    private static let row: CGFloat = 46
    private static let menuWidth: CGFloat = 240

    var body: some View {
        GeometryReader { proxy in
            let insets = UIApplication.shared.windowInsets
            let place = layout(size: proxy.size, top: insets.top + 8, bottom: proxy.size.height - insets.bottom - 8)
            ZStack(alignment: .topLeading) {
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .overlay(Color.black.opacity(0.12))
                    .opacity(lifted ? 1 : 0)
                    .ignoresSafeArea()
                    .onTapGesture { pick(nil) }
                    .accessibilityLabel("Close")
                    .accessibilityAddTraits(.isButton)

                if let reactions = request.reactions {
                    reactionBar(reactions)
                        .scaleEffect(lifted ? 1 : 0.6, anchor: request.mine ? .bottomTrailing : .bottomLeading)
                        .opacity(lifted ? 1 : 0)
                        .position(x: place.reactions.midX, y: place.reactions.midY)
                }

                if let snapshot = menu.snapshot {
                    Image(uiImage: snapshot)
                        .resizable()
                        .frame(width: place.bubble.width, height: request.rect.height)
                        .frame(height: place.bubble.height, alignment: .top)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .scaleEffect(lifted ? 1.03 : 1)
                        .shadow(color: .black.opacity(lifted ? 0.18 : 0), radius: 18, y: 8)
                        .position(x: place.bubble.midX, y: lifted ? place.bubble.midY : request.rect.y + place.bubble.height / 2)
                        .allowsHitTesting(false)
                }

                if !request.items.isEmpty {
                    actions
                        .frame(width: Self.menuWidth)
                        .scaleEffect(lifted ? 1 : 0.6, anchor: request.mine ? .topTrailing : .topLeading)
                        .opacity(lifted ? 1 : 0)
                        .position(x: place.menu.midX, y: place.menu.midY)
                }
            }
        }
        .ignoresSafeArea()
        .onAppear { withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { lifted = true } }
    }

    private struct Placement {
        var bubble: CGRect
        var reactions: CGRect
        var menu: CGRect
    }

    /// Keeps the bubble where it was when everything fits, else moves it just enough, and shows only its top when it is taller than the room left.
    private func layout(size: CGSize, top: CGFloat, bottom: CGFloat) -> Placement {
        let gap: CGFloat = 8
        let rect = CGRect(x: request.rect.x, y: request.rect.y, width: request.rect.width, height: request.rect.height)
        let reactionsHeight: CGFloat = request.reactions == nil ? 0 : 56
        let reactionsWidth = CGFloat(request.reactions?.options.count ?? 0) * 44 + 12
        let menuHeight = request.items.isEmpty ? 0 : CGFloat(request.items.count) * Self.row + 12
        let above = reactionsHeight > 0 ? reactionsHeight + gap : 0
        let below = menuHeight > 0 ? menuHeight + gap : 0
        let height = max(44, min(rect.height, bottom - top - above - below))
        let y = min(max(rect.minY, top + above), max(top + above, bottom - below - height))
        let bubble = CGRect(x: rect.minX, y: y, width: rect.width, height: height)
        func aligned(_ width: CGFloat) -> CGFloat {
            let x = request.mine ? rect.maxX - width : rect.minX
            return min(max(12, x), size.width - 12 - width)
        }
        return Placement(
            bubble: bubble,
            reactions: CGRect(x: aligned(reactionsWidth), y: y - above, width: reactionsWidth, height: reactionsHeight),
            menu: CGRect(x: aligned(Self.menuWidth), y: bubble.maxY + gap, width: Self.menuWidth, height: menuHeight)
        )
    }

    private func reactionBar(_ reactions: MessageMenuRequest.Reactions) -> some View {
        HStack(spacing: 0) {
            ForEach(reactions.options, id: \.self) { emoji in
                Button { pick(["react": emoji]) } label: {
                    Text(emoji)
                        .font(.system(size: 26))
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(reactions.mine == emoji ? Theme.foreground.opacity(0.14) : .clear))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(reactions.mine == emoji ? "Remove \(emoji)" : "React \(emoji)")
            }
        }
        .padding(6)
        .glassControl(in: Capsule(), interactive: false)
    }

    private var actions: some View {
        VStack(spacing: 0) {
            ForEach(Array(request.items.enumerated()), id: \.element.id) { index, item in
                Button { pick(["action": item.id]) } label: {
                    HStack {
                        Text(item.label)
                        Spacer(minLength: 12)
                        Image(systemName: item.symbol)
                    }
                    .font(.system(size: 16))
                    .padding(.horizontal, 18)
                    .frame(height: Self.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(item.destructive == true ? Theme.destructive : Theme.foreground)
                if index < request.items.count - 1 {
                    Divider().padding(.leading, 18)
                }
            }
        }
        .padding(.vertical, 6)
        .glassControl(in: RoundedRectangle(cornerRadius: 26, style: .continuous), interactive: false)
    }
}

// MARK: Glass

extension View {
    /// A control in Liquid Glass from iOS 26, interactive so it reacts to a touch; a material before it.
    @ViewBuilder
    func glassControl<S: Shape>(in shape: S, interactive: Bool = true) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
        }
    }
}

/// Glass shapes that sit together blend as one from iOS 26, as Apple's own bars do.
struct GlassGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 12) { content }
        } else {
            content
        }
    }
}

extension UIApplication {
    private var mainWindow: UIWindow? {
        let scenes = connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
    }

    var windowInsets: UIEdgeInsets { mainWindow?.safeAreaInsets ?? .zero }
    var windowBounds: CGRect { mainWindow?.bounds ?? .zero }
}
