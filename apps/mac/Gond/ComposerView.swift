import AppKit
import os
import SwiftUI
import UniformTypeIdentifiers

/// A conversation's composer, floating over the bottom of the page's column, with what sits on it:
/// the room's bots to @mention, the files going with it, the quote being answered, or a call in its place.
struct ComposerLayer: View {
    @Environment(\.chromeScale) private var s
    @ObservedObject var ui: NativeUI
    let state: ChromeState
    /// The detail's width, which the page's column is centred in.
    let width: CGFloat

    @State private var text = ""
    @State private var appliedRev = -1
    @State private var blockHeight: CGFloat = 44
    @State private var fieldHeight: CGFloat = 18

    var body: some View {
        let margin = 16 * s
        let place = placement(margin: margin)
        let covered = ui.covered
        block
            .frame(width: place.width)
            .padding(.leading, place.x)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .padding(.bottom, margin)
            // Under something of the page's, the page's own scrim covers where it sits.
            .opacity(covered ? 0 : 1)
            .allowsHitTesting(!covered)
            .animation(.easeOut(duration: 0.15), value: covered)
            .onAppear {
                applyPageText()
                push(bottom: margin)
            }
            .onChange(of: state.composer.textRev) { applyPageText() }
            .onChange(of: blockHeight) { push(bottom: margin) }
            .onChange(of: margin) { push(bottom: margin) }
    }

    /// Over the page's column: where it says that is, else centred, at most 46rem wide as the column is.
    private func placement(margin: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let widest = 736 * s
        if let column = state.column, column.width > 0 {
            let room = CGFloat(column.width) - 2 * margin
            let w = max(160, min(room, widest))
            return (max(0, CGFloat(column.x) + (CGFloat(column.width) - w) / 2), w)
        }
        let w = max(160, min(width - 2 * margin, widest))
        return (max(0, (width - w) / 2), w)
    }

    private func push(bottom: CGFloat) {
        ui.shell?.setComposerMetrics((bottom: bottom, height: blockHeight))
    }

    /// The field owns the text while it is typed in; the page's copy goes in only when the page changed it itself.
    private func applyPageText() {
        guard state.composer.textRev > appliedRev else { return }
        appliedRev = state.composer.textRev
        guard text != state.composer.text else { return }
        text = state.composer.text
    }

    private var tint: Color { Color.css(state.tint, or: Theme.tint) }

    private var block: some View {
        VStack(alignment: .leading, spacing: 8 * s) {
            if !state.mentions.isEmpty { mentions }
            if !state.files.isEmpty { files }
            if state.call == nil, let replying = state.replying { quote(replying) }
            if let call = state.call {
                callBar(call)
            } else {
                composer
            }
        }
        .foregroundStyle(Theme.foreground)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { blockHeight = $0 }
        .overlay(alignment: .topTrailing) {
            if state.jump {
                Button { ui.send(["type": "jump"]) } label: {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 14 * s, weight: .semibold))
                        .frame(width: 36 * s, height: 36 * s)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.foreground)
                .glassControl(in: Circle())
                .offset(y: -44 * s)
                .help("Scroll to the newest")
                .accessibilityLabel("Scroll to end")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: state.jump)
        .dropDestination(for: URL.self) { urls, _ in
            ui.attach(urls)
            return true
        }
    }

    private var mentions: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            GlassGroup {
                HStack(spacing: 6 * s) {
                    ForEach(state.mentions) { mention in
                        Button { ui.send(["type": "mention", "id": mention.id]) } label: {
                            HStack(spacing: 6 * s) {
                                if let face = ui.mentionFaces[mention.id] {
                                    Image(nsImage: face).resizable().interpolation(.high).frame(width: 18 * s, height: 18 * s)
                                }
                                Text("@\(mention.handle)").font(.system(size: 12 * s, weight: .medium))
                            }
                            .padding(.leading, 5 * s)
                            .padding(.trailing, 10 * s)
                            .frame(height: 28 * s)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .glassControl(in: Capsule())
                    }
                }
                .padding(.vertical, 2 * s)
            }
        }
        .scrollClipDisabled()
    }

    private var files: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6 * s) {
                ForEach(Array(state.files.enumerated()), id: \.offset) { index, file in
                    HStack(spacing: 8 * s) {
                        Image(systemName: "paperclip").font(.system(size: 12 * s))
                        VStack(alignment: .leading, spacing: 0) {
                            Text(file.name).font(.system(size: 12 * s, weight: .medium)).lineLimit(1)
                            Text(file.size).font(.system(size: 10 * s)).foregroundStyle(Theme.muted)
                        }
                        Button { ui.send(["type": "remove-file", "index": index]) } label: {
                            Image(systemName: "xmark").font(.system(size: 10 * s, weight: .bold)).frame(width: 24 * s, height: 24 * s).contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .help("Remove \(file.name)")
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .padding(.leading, 12 * s)
                    .padding(.trailing, 4 * s)
                    .frame(height: 38 * s)
                    .frame(maxWidth: 240 * s)
                    .glassControl(in: Capsule(), interactive: false)
                }
            }
            .padding(.vertical, 2 * s)
        }
        .scrollClipDisabled()
    }

    private func quote(_ replying: ChromeState.Replying) -> some View {
        HStack(spacing: 10 * s) {
            Image(systemName: "arrowshape.turn.up.left").font(.system(size: 12 * s)).foregroundStyle(Theme.muted)
            Capsule().fill(Color.css(replying.color, or: Theme.muted)).frame(width: 3 * s, height: 28 * s)
            VStack(alignment: .leading, spacing: 1 * s) {
                Text(replying.name).font(.system(size: 12 * s, weight: .semibold))
                Text(replying.text).font(.system(size: 12 * s)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button { ui.send(["type": "cancel-reply"]) } label: {
                Image(systemName: "xmark").font(.system(size: 11 * s, weight: .bold)).frame(width: 30 * s, height: 30 * s).contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Don't reply to it")
            .accessibilityLabel("Don't reply to it")
        }
        .padding(.leading, 14 * s)
        .padding(.trailing, 4 * s)
        .padding(.vertical, 5 * s)
        .fixedSize(horizontal: false, vertical: true)
        .glassControl(in: RoundedRectangle(cornerRadius: 20 * s, style: .continuous), interactive: false)
    }

    /// On a call the composer is the call, as on the page: mute, what is happening and the clock, hang up.
    private func callBar(_ call: ChromeState.Call) -> some View {
        let bot = Color.css(call.color, or: Theme.foreground)
        return GlassGroup {
            HStack(spacing: 10 * s) {
                Button { ui.send(["type": "call-mute"]) } label: {
                    Image(systemName: call.muted ? "mic.slash.fill" : "mic")
                        .font(.system(size: 16 * s, weight: .medium))
                        .frame(width: 40 * s, height: 40 * s)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassControl(in: Circle())
                .help(call.muted ? "Unmute" : "Mute")
                .accessibilityLabel(call.muted ? "Unmute" : "Mute")
                .accessibilityIdentifier("composer.call-mute")

                HStack(spacing: 10 * s) {
                    Text(call.label)
                        .font(.system(size: 13 * s, weight: .medium))
                        .lineLimit(1)
                        .opacity(call.connecting ? 0.6 : 1)
                    CallClock(since: call.since)
                    Spacer(minLength: 0)
                    CallBars(color: call.speaking ? bot : tint, quiet: call.muted && !call.speaking)
                        .accessibilityHidden(true)
                }
                .padding(.leading, 18 * s)
                .padding(.trailing, 16 * s)
                .frame(height: 40 * s)
                .frame(maxWidth: .infinity)
                .glassControl(in: Capsule(), interactive: false)
                .accessibilityElement(children: .combine)

                Button { ui.send(["type": "call-end"]) } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 16 * s, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40 * s, height: 40 * s)
                        .background(Circle().fill(Theme.hangup))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help("End the call")
                .accessibilityLabel("End the call")
                .accessibilityIdentifier("composer.call-end")
            }
            .foregroundStyle(Theme.foreground)
        }
    }

    private var composer: some View {
        let font = 14 * s
        let button = 34 * s
        let line = ComposerField.lineHeight(fontSize: font)
        return HStack(alignment: .bottom, spacing: 4 * s) {
            Button { ui.pickFiles() } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 16 * s, weight: .medium))
                    .frame(width: button, height: button)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Attach files")
            .accessibilityLabel("Attach files")
            .accessibilityIdentifier("composer.attach")

            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(state.composer.placeholder)
                        .font(.system(size: font))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                ComposerField(
                    text: $text,
                    height: $fieldHeight,
                    fontSize: font,
                    placeholder: state.composer.placeholder,
                    focusRev: state.composer.focusRev,
                    onEdit: { value in ui.send(["type": "text", "value": value]) },
                    onSend: sendNow,
                    onFiles: { urls in ui.attach(urls) },
                    onPicture: { png in ui.attachPicture(png) }
                )
                .frame(height: max(line, fieldHeight))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4 * s)
            .padding(.vertical, max(0, (button - line) / 2))

            trailing(button: button)
        }
        .padding(5 * s)
        .glassControl(in: RoundedRectangle(cornerRadius: (button + 10 * s) / 2, style: .continuous), interactive: false)
    }

    /// Return sends whatever the page holds; the page decides whether there is anything to send.
    private func sendNow() {
        guard !state.composer.sending else { return }
        ui.send(["type": "send"])
    }

    private func sendLater() {
        ui.send(["type": "send", "later": true])
    }

    @ViewBuilder
    private func trailing(button: CGFloat) -> some View {
        let composer = state.composer
        HStack(spacing: 2 * s) {
            if composer.voice == "recording" {
                Text("\(composer.seconds / 60):\(composer.seconds % 60 < 10 ? "0" : "")\(composer.seconds % 60)")
                    .font(.system(size: 11 * s).monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 4 * s)
            }
            Button { ui.send(["type": "voice"]) } label: {
                Group {
                    if composer.voice == "working" {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: composer.voice == "recording" ? "stop.fill" : "mic")
                            .font(.system(size: 15 * s, weight: .medium))
                    }
                }
                .frame(width: button, height: button)
                .background(Circle().fill(composer.voice == "recording" ? Theme.foreground.opacity(0.12) : .clear))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .opacity(composer.voice == "off" ? 0.45 : 1)
            .disabled(composer.voice == "working")
            .help(composer.voice == "recording" ? "Stop and turn it into text" : "Talk instead of typing")
            .accessibilityLabel(composer.voice == "recording" ? "Stop and turn it into text" : "Talk instead of typing")
            .accessibilityIdentifier("composer.voice")

            if composer.later {
                Menu {
                    Button("Send after it finishes", action: sendLater)
                } label: {
                    Image(systemName: "chevron.down")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("More ways to send")
                .accessibilityLabel("More ways to send")
            }

            Button(action: sendNow) {
                Group {
                    if composer.sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 14 * s, weight: .bold))
                    }
                }
                .foregroundStyle(.white)
                .frame(width: button, height: button)
                .background(Circle().fill(tint))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .opacity(composer.canSend ? 1 : 0.4)
            .disabled(!composer.canSend)
            .contextMenu {
                if composer.later { Button("Send after it finishes", action: sendLater) }
            }
            .help("Send")
            .accessibilityLabel("Send")
            .accessibilityIdentifier("composer.send")
        }
    }
}

/// The composer's field: Return sends, Shift or Option with Return starts a new line, and a word
/// still being composed in an input method is never sent. Pasted or dropped files go with the message.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let fontSize: CGFloat
    let placeholder: String
    let focusRev: Int
    let onEdit: (String) -> Void
    let onSend: () -> Void
    let onFiles: ([URL]) -> Void
    let onPicture: (Data) -> Void

    static let maxLines: CGFloat = 8

    static func lineHeight(fontSize: CGFloat) -> CGFloat {
        ceil(NSLayoutManager().defaultLineHeight(for: NSFont.systemFont(ofSize: fontSize)))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)

        let textView = ComposerTextView(frame: .zero, textContainer: container)
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: 0)
        textView.font = NSFont.systemFont(ofSize: fontSize)
        textView.textColor = NSColor.labelColor
        textView.string = text
        textView.delegate = context.coordinator
        textView.onFiles = onFiles
        textView.onPicture = onPicture
        textView.onWidth = { [weak coordinator = context.coordinator] in coordinator?.measure() }
        textView.setAccessibilityIdentifier("composer.field")
        textView.setAccessibilityLabel(placeholder.isEmpty ? "Message" : placeholder)

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView

        context.coordinator.textView = textView
        context.coordinator.focusRev = focusRev
        context.coordinator.measure()
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let textView = coordinator.textView else { return }
        textView.onFiles = onFiles
        textView.onPicture = onPicture
        if textView.font?.pointSize != fontSize {
            textView.font = NSFont.systemFont(ofSize: fontSize)
            coordinator.measure()
        }
        // The page's own change (sent, a mention, a dictation); never in the middle of a word being composed.
        if textView.string != text && !textView.hasMarkedText() {
            textView.string = text
            textView.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            coordinator.measure()
        }
        if focusRev != coordinator.focusRev {
            coordinator.focusRev = focusRev
            Task { @MainActor in _ = textView.window?.makeFirstResponder(textView) }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        weak var textView: ComposerTextView?
        var focusRev = 0

        init(_ parent: ComposerField) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            let value = textView.string
            if parent.text != value { parent.text = value }
            parent.onEdit(value)
            measure()
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                if textView.hasMarkedText() { return false }
                let flags = NSApp.currentEvent?.modifierFlags ?? []
                if flags.contains(.shift) || flags.contains(.option) || flags.contains(.control) {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                parent.onSend()
                return true
            }
            if commandSelector == #selector(NSResponder.insertLineBreak(_:)) || commandSelector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)) {
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            }
            return false
        }

        /// Grows with the text, a line at a time, up to `maxLines`; past that it scrolls.
        func measure() {
            guard let textView, let layout = textView.layoutManager, let container = textView.textContainer else { return }
            layout.ensureLayout(for: container)
            let line = layout.defaultLineHeight(for: textView.font ?? NSFont.systemFont(ofSize: parent.fontSize))
            let used = layout.usedRect(for: container).height
            let next = ceil(min(max(used, line), line * ComposerField.maxLines))
            guard abs(next - parent.height) > 0.5 else { return }
            let binding = parent.$height
            Task { @MainActor in binding.wrappedValue = next }
        }
    }
}

/// The field's text view: a paste or drop of files, or of a picture alone, attaches them instead of typing their names.
final class ComposerTextView: NSTextView {
    var onFiles: (([URL]) -> Void)?
    var onPicture: ((Data) -> Void)?
    var onWidth: (() -> Void)?

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.size.width) > 0.5
        super.setFrameSize(newSize)
        if widthChanged { onWidth?() }
    }

    override func paste(_ sender: Any?) {
        if attachFromPasteboard() { return }
        super.paste(sender)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if window?.firstResponder === self, flags == .command, event.charactersIgnoringModifiers == "v", attachFromPasteboard() { return true }
        return super.performKeyEquivalent(with: event)
    }

    // Text still drops here; files go to the composer around it, which attaches them.
    override func updateDragTypeRegistration() {
        unregisterDraggedTypes()
        registerForDraggedTypes([.string])
    }

    private func attachFromPasteboard() -> Bool {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            onFiles?(urls)
            return true
        }
        // A picture with words beside it (copied from a page) pastes the words, as everywhere else.
        guard board.string(forType: .string) == nil else { return false }
        if let png = board.data(forType: .png) {
            onPicture?(png)
            return true
        }
        if let tiff = board.data(forType: .tiff), let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            onPicture?(png)
            return true
        }
        return false
    }
}

/// "1:31", how long the call has run, ticking each second.
struct CallClock: View {
    @Environment(\.chromeScale) private var s
    let since: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince1970 - since / 1000))
            Text("\(seconds / 60):\(seconds % 60 < 10 ? "0" : "")\(seconds % 60)")
                .font(.system(size: 11 * s).monospacedDigit())
                .foregroundStyle(Theme.muted)
        }
    }
}

/// The call's five bars, in the person's colour while they talk and the bot's while it does. The app
/// doesn't hear the audio, so they sway rather than follow it; still while muted or under reduced motion.
private struct CallBars: View {
    @Environment(\.chromeScale) private var s
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let color: Color
    let quiet: Bool
    private static let heights: [CGFloat] = [0.5, 0.8, 1, 0.8, 0.5]

    private func height(of bar: Int, at time: Double) -> CGFloat {
        let index = Double(bar)
        let sway: Double = quiet ? 0.18 : reduceMotion ? 0.5 : 0.25 + 0.75 * abs(sin(time * (4 + index) + index * 1.3))
        return max(4, 18 * Self.heights[bar] * CGFloat(sway)) * s
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.08, paused: quiet || reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3 * s) {
                ForEach(0..<5, id: \.self) { i in
                    Capsule()
                        .fill(quiet ? Theme.muted.opacity(0.5) : color)
                        .frame(width: 3 * s, height: height(of: i, at: t))
                }
            }
            .frame(height: 18 * s)
        }
    }
}
