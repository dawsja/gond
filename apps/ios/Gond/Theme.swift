import SwiftUI
import UIKit

/// The web app's tokens (apps/web/app/globals.css), so Connect and the pages after it look like one app.
enum Theme {
    static let background = Color("Background")
    static let foreground = dynamic(light: 0x1B1A18, dark: 0xE0E0E0)
    static let muted = dynamic(light: 0x524F4A, dark: 0xA0A0A0)
    static let destructive = dynamic(light: 0xC2301A, dark: 0xCF6679)
    /// The person's own blue, the default accent: what fills the Connect button.
    static let tint = Color(hex: 0x2F6FD6)

    /// Colours a bot can wear, for the faces behind the Connect card.
    static let bots: [Color] = [Color(hex: 0x2F6FD6), Color(hex: 0x1F9E8F), Color(hex: 0xD2483C)]

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
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
            self.init(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: 1)
            return
        }
        return nil
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(UIColor(hex: hex))
    }
}

/// The Gond bot's cog, from apps/web/components/hq/gond-bot.tsx, in its 100 by 100 box.
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

/// A bot's face: the cog in its colour with the two tilted eyes.
struct BotFace: View {
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width, geometry.size.height) / 100
            ZStack(alignment: .topLeading) {
                CogShape().fill(color)
                CogShape().stroke(color, style: StrokeStyle(lineWidth: 5 * scale, lineJoin: .round))
                eye(x: 44, y: 56.5, scale: scale)
                eye(x: 60.5, y: 53, scale: scale)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private func eye(x: CGFloat, y: CGFloat, scale: CGFloat) -> some View {
        Capsule()
            .fill(.white)
            .frame(width: 7 * scale, height: 17 * scale)
            .rotationEffect(.degrees(-10))
            .position(x: x * scale, y: y * scale)
    }
}
