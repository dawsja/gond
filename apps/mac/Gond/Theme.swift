import AppKit
import SwiftUI

/// The web app's tokens (apps/web/app/globals.css), so Connect and the app's own chrome look like the pages they sit on.
enum Theme {
    static let background = dynamic(light: 0xF6F7F9, dark: 0x000000)
    static let foreground = dynamic(light: 0x16181D, dark: 0xEDEDED)
    static let muted = dynamic(light: 0x5B6170, dark: 0xA1A1A1)
    /// Quieter text, a row's time and a teammates-only unread dot (`--ash`).
    static let ash = dynamic(light: 0x646A79, dark: 0x8A8A8A)
    static let destructive = dynamic(light: 0xBD1F1F, dark: 0xF97C7C)
    /// A call's hang-up red, deep enough for a white icon in both themes (`--hangup`).
    static let hangup = dynamic(light: 0xC2301A, dark: 0xC4372B)
    /// The person's own blue, the default accent: what fills the Connect button.
    static let tint = Color(hex: 0x2F6FD6)

    /// Colours a bot can wear, for the faces above the Connect card.
    static let bots: [UInt32] = [0x2F6FD6, 0x1F9E8F, 0xD2483C]

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light)
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// A CSS colour as the web app reports it: #rgb, #rrggbb or rgb(r, g, b).
    convenience init?(css: String) {
        let value = css.trimmingCharacters(in: .whitespaces).lowercased()
        if value.hasPrefix("#") {
            var digits = String(value.dropFirst())
            if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
            guard digits.count == 6, let hex = UInt32(digits, radix: 16) else { return nil }
            self.init(hex: hex)
            return
        }
        if value.hasPrefix("rgb") {
            let numbers = value.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).compactMap(Double.init)
            guard numbers.count >= 3 else { return nil }
            self.init(srgbRed: CGFloat(numbers[0] / 255), green: CGFloat(numbers[1] / 255), blue: CGFloat(numbers[2] / 255), alpha: 1)
            return
        }
        return nil
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }

    /// A colour the page sent, or `fallback` when it can't be read.
    static func css(_ value: String, or fallback: Color) -> Color {
        NSColor(css: value).map { Color(nsColor: $0) } ?? fallback
    }
}

private struct ChromeScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1
}

extension EnvironmentValues {
    /// How many points a CSS pixel takes on the page (Settings → Appearance → Size). The composer sits
    /// where the page's own would, so it is drawn at the page's size; menus and toasts stay the system's.
    var chromeScale: CGFloat {
        get { self[ChromeScaleKey.self] }
        set { self[ChromeScaleKey.self] = newValue }
    }
}

// MARK: Glass

extension View {
    /// A control in Liquid Glass from macOS 26, interactive so it reacts to the pointer; a material before it.
    @ViewBuilder
    func glassControl<S: Shape>(in shape: S, interactive: Bool = true) -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.1), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.1), radius: 10, y: 3)
        }
    }

    /// The main action: glass tinted the person's colour from macOS 26, a filled pill before it.
    @ViewBuilder
    func prominentGlass<S: Shape>(in shape: S, tint: Color) -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(.regular.tint(tint).interactive(), in: shape)
        } else {
            background(tint, in: shape)
        }
    }
}

/// Glass shapes that sit together blend as one from macOS 26, as Apple's own bars do.
struct GlassGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: 12) { content }
        } else {
            content
        }
    }
}

/// What the app lays over its own pieces while something of the page's is open over the conversation:
/// the page's own scrim colour, and a click on it closes that thing as Escape would.
struct Scrim: View {
    let dismiss: () -> Void

    var body: some View {
        Color.black.opacity(0.6)
            .contentShape(Rectangle())
            .onTapGesture(perform: dismiss)
            .accessibilityLabel("Close")
            .accessibilityAddTraits(.isButton)
    }
}

// MARK: The mascot

/// The Gond bot's cog, from apps/web/components/hq/gond-bot-shapes.ts, in its 100 by 100 box.
struct CogShape: Shape {
    private static let points: [CGFloat] = [
        40.14, 25.36, 44.29, 23.64, 45, 17, 52, 17, 59, 17, 59.71, 23.64, 63.86, 25.36, 68.02, 27.08, 73.21, 22.89, 78.16, 27.84,
        83.11, 32.79, 78.92, 37.98, 80.64, 42.14, 82.36, 46.29, 89, 47, 89, 54, 89, 61, 82.36, 61.71, 80.64, 65.86,
        78.92, 70.02, 83.11, 75.21, 78.16, 80.16, 73.21, 85.11, 68.02, 80.92, 63.86, 82.64, 59.71, 84.36, 59, 91, 52, 91,
        45, 91, 44.29, 84.36, 40.14, 82.64, 35.98, 80.92, 30.79, 85.11, 25.84, 80.16, 20.89, 75.21, 25.08, 70.02, 23.36, 65.86,
        21.64, 61.71, 15, 61, 15, 54, 15, 47, 21.64, 46.29, 23.36, 42.14, 25.08, 37.98, 20.89, 32.79, 25.84, 27.84,
        30.79, 22.89, 35.98, 27.08, 40.14, 25.36,
    ]

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 100
        let point = { (i: Int) in CGPoint(x: rect.minX + Self.points[i] * scale, y: rect.minY + Self.points[i + 1] * scale) }
        var path = Path()
        path.move(to: point(0))
        var i = 2
        while i + 5 < Self.points.count {
            path.addCurve(to: point(i + 4), control1: point(i), control2: point(i + 2))
            i += 6
        }
        path.closeSubpath()
        return path
    }
}

/// A bot's face as the web app draws it (apps/web/components/hq/gond-bot.tsx): the cog shaded from its one
/// colour around a still hub, a dark visor, glowing eyes and a mouth. Drawn in the cog's 100 by 100 box.
struct BotFace: View {
    let hex: UInt32

    var body: some View {
        Canvas { context, size in
            let unit = min(size.width, size.height) / 100
            let scale = CGAffineTransform(scaleX: unit, y: unit)
            let at = { (x: CGFloat, y: CGFloat) in CGPoint(x: x * unit, y: y * unit) }
            let tone = BotTone(hex)

            let cog = CogShape().path(in: CGRect(x: 0, y: 0, width: 100, height: 100)).applying(scale)
            let hub = Path(ellipseIn: CGRect(x: 21, y: 23, width: 62, height: 62)).applying(scale)
            let visor = Path(ellipseIn: CGRect(x: 28, y: 30, width: 48, height: 48)).applying(scale)

            // A gradient across a box the way SVG's x1 20% y1 0% x2 80% y2 100% runs.
            let bodyShading = { (x: CGFloat, y: CGFloat, side: CGFloat) in
                GraphicsContext.Shading.linearGradient(
                    Gradient(stops: [.init(color: tone.top, location: 0), .init(color: tone.base, location: 0.55), .init(color: tone.bottom, location: 1)]),
                    startPoint: at(x + side * 0.2, y), endPoint: at(x + side * 0.8, y + side))
            }
            let rim = GraphicsContext.Shading.linearGradient(
                Gradient(stops: [.init(color: tone.rimLight.opacity(0.9), location: 0), .init(color: tone.base.opacity(0), location: 0.45), .init(color: tone.rimDark.opacity(0.9), location: 1)]),
                startPoint: at(52, 17), endPoint: at(52, 91))

            context.stroke(cog, with: rim, style: StrokeStyle(lineWidth: 6.6 * unit, lineJoin: .round))
            context.fill(cog, with: bodyShading(15, 17, 74))
            context.stroke(cog, with: bodyShading(15, 17, 74), style: StrokeStyle(lineWidth: 5 * unit, lineJoin: .round))
            context.stroke(hub, with: .color(tone.rimDark.opacity(0.35)), style: StrokeStyle(lineWidth: 1.6 * unit))
            context.fill(hub, with: bodyShading(21, 23, 62))
            context.fill(hub, with: .radialGradient(Gradient(colors: [.white.opacity(0.42), .white.opacity(0)]), center: at(40.84, 34.16), startRadius: 0, endRadius: 38.4 * unit))

            context.stroke(visor, with: .color(.black.opacity(0.32)), style: StrokeStyle(lineWidth: 2.4 * unit))
            context.fill(visor, with: .linearGradient(Gradient(colors: [tone.visorTop, tone.visorBottom]), startPoint: at(52, 30), endPoint: at(52, 78)))

            var inside = context
            inside.clip(to: visor)
            inside.fill(visor, with: .radialGradient(Gradient(colors: [tone.glow.opacity(0.26), tone.glow.opacity(0)]), center: at(50, 48), startRadius: 0, endRadius: 55 * unit))

            // The face sits a touch up and in, scaled about the middle of the eyes and mouth.
            let face = CGAffineTransform(translationX: -52.25, y: -58)
                .concatenating(CGAffineTransform(scaleX: 0.92, y: 0.92))
                .concatenating(CGAffineTransform(translationX: 52.25, y: 57))
                .concatenating(scale)
            var lit = inside
            lit.addFilter(.shadow(color: tone.glow.opacity(0.9), radius: 1.8 * unit))
            for (x, y) in [(CGFloat(44), CGFloat(56.5)), (CGFloat(60.5), CGFloat(53))] {
                let tilt = CGAffineTransform(translationX: -x, y: -y)
                    .concatenating(CGAffineTransform(rotationAngle: -16 * .pi / 180))
                    .concatenating(CGAffineTransform(translationX: x, y: y))
                    .concatenating(face)
                lit.fill(Path(roundedRect: CGRect(x: x - 3.7, y: y - 9, width: 7.4, height: 18), cornerRadius: 3.7, style: .circular).applying(tilt), with: .color(tone.eye))
                inside.fill(Path(ellipseIn: CGRect(x: x - 2.5, y: y - 6.3, width: 2.6, height: 2.6)).applying(tilt), with: .color(.white.opacity(0.7)))
            }
            lit.fill(Path(roundedRect: CGRect(x: 49, y: 68.2, width: 7.5, height: 2.6), cornerRadius: 1.3, style: .circular).applying(face), with: .color(tone.glow.opacity(0.85)))

            var sheen = Path()
            sheen.addLines([CGPoint(x: 20, y: 20), CGPoint(x: 58, y: 20), CGPoint(x: 36, y: 90), CGPoint(x: 20, y: 90)])
            sheen.closeSubpath()
            inside.fill(sheen.applying(scale), with: .linearGradient(Gradient(colors: [.white.opacity(0.16), .white.opacity(0)]), startPoint: at(20, 20), endPoint: at(58, 90)))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// The shades of one bot colour, mixed as the web app mixes them.
private struct BotTone {
    let base, top, bottom, rimLight, rimDark, visorTop, visorBottom, eye, glow: Color

    init(_ hex: UInt32) {
        let channels = { (value: UInt32) -> (Double, Double, Double) in
            (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
        }
        let (red, green, blue) = channels(hex)
        let mix = { (to: UInt32, amount: Double) -> Color in
            let (r, g, b) = channels(to)
            return Color(.sRGB, red: red + (r - red) * amount, green: green + (g - green) * amount, blue: blue + (b - blue) * amount, opacity: 1)
        }
        base = Color(hex: hex)
        top = mix(0xFFFFFF, 0.3)
        bottom = mix(0x000000, 0.36)
        rimLight = mix(0xFFFFFF, 0.75)
        rimDark = mix(0x000000, 0.62)
        visorTop = mix(0x0A0B0D, 0.84)
        visorBottom = mix(0x050506, 0.94)
        eye = mix(0xFFFFFF, 0.88)
        glow = mix(0xFFFFFF, 0.4)
    }
}
