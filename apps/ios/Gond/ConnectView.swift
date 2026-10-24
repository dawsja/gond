import SwiftUI

/// The app's one screen of its own: where your Gond is. Everything after it is your Gond's web app.
struct ConnectView: View {
    @ObservedObject var model: AppModel
    @FocusState private var typing: Bool

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            faces
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    CogShape().fill(Theme.foreground).frame(width: 28, height: 28)
                    Text("Gond").font(.system(size: 18, weight: .bold))
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 24)
                Text("Connect")
                    .font(.system(size: 13, weight: .semibold))
                    .kerning(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.muted)
                Text("Where is your Gond?")
                    .font(.system(size: 34, weight: .bold))
                    .padding(.top, 8)
                Text("Enter the address you open Gond at in your browser.")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 10)
                form.padding(.top, 26)
                if model.canGoBack, let server = model.server {
                    Button("Back to \(server)") { model.backToServer() }
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.foreground)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 18)
                }
                Spacer(minLength: 24)
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 28)
            .padding(.vertical, 16)
            .frame(maxWidth: 520)
        }
    }

    /// Bots' faces behind the card, so the glass has something to bend.
    private var faces: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack {
                BotFace(color: Theme.bots[0]).frame(width: 200).rotationEffect(.degrees(-12)).position(x: width * 0.12, y: geometry.size.height * 0.2)
                BotFace(color: Theme.bots[1]).frame(width: 160).rotationEffect(.degrees(14)).position(x: width * 0.94, y: geometry.size.height * 0.27)
                BotFace(color: Theme.bots[2]).frame(width: 140).rotationEffect(.degrees(8)).position(x: width * 0.78, y: geometry.size.height * 0.76)
            }
        }
        .ignoresSafeArea()
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Address")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.muted)
                .padding(.leading, 6)
            TextField("https://gond.example.com", text: $model.address)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($typing)
                .onSubmit(connect)
                .onChange(of: model.address) { model.connectError = nil }
                .disabled(model.connecting)
                .font(.system(size: 16))
                .padding(.horizontal, 18)
                .frame(height: 52)
                .glass(in: Capsule())
            if let error = model.connectError {
                Text(error)
                    .font(.system(size: 13.5))
                    .foregroundStyle(Theme.destructive)
                    .padding(.horizontal, 6)
                    .accessibilityAddTraits(.isStaticText)
            }
            Button(action: connect) {
                HStack(spacing: 8) {
                    if model.connecting { ProgressView().tint(.white) }
                    Text(model.connecting ? "Connecting…" : "Connect").font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 54)
            }
            .prominentGlass()
            .disabled(model.connecting)
            .padding(.top, 6)
        }
        .padding(18)
        .glass(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
    }

    private func connect() {
        typing = false
        Task { await model.connect() }
    }
}

extension View {
    /// Liquid Glass from iOS 26, a material before it.
    @ViewBuilder
    func glass<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
        }
    }

    /// The main action: glass tinted the person's colour from iOS 26, a filled pill before it.
    @ViewBuilder
    func prominentGlass() -> some View {
        if #available(iOS 26.0, *) {
            buttonStyle(.glassProminent).tint(Theme.tint)
        } else {
            buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Theme.tint)
        }
    }
}

#Preview {
    ConnectView(model: AppModel())
}
