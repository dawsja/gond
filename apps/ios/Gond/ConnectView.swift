import SwiftUI

/// The app's one screen of its own: where your Gond is. Everything after it is your Gond's web app.
struct ConnectView: View {
    @ObservedObject var model: AppModel
    @FocusState private var typing: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    CogShape().fill(Theme.foreground).frame(width: 28, height: 28)
                    Text("Gond").font(.system(size: 18, weight: .bold))
                }
                .accessibilityElement(children: .combine)
                .padding(.top, 14)
                // The team stands above the words, never behind them; it steps aside while you type,
                // so the title and the card rise above the keyboard instead of being pushed under it.
                if !typing {
                    team
                        .padding(.top, 28)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                Text("Where is your Gond?")
                    .font(.system(size: 34, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, typing ? 28 : 32)
                Text("Enter the address you open Gond at in your browser.")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
                form.padding(.top, 24)
                if model.canGoBack, let server = model.server {
                    Button("Back to \(server)") { model.backToServer() }
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.foreground)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 18)
                }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 28)
            .padding(.bottom, 24)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background.ignoresSafeArea())
        .animation(.snappy(duration: 0.3), value: typing)
    }

    /// Three bots' faces, standing together like the team you're about to reach.
    private var team: some View {
        HStack(alignment: .top, spacing: -14) {
            BotFace(color: Theme.bots[0]).frame(width: 150).rotationEffect(.degrees(-10))
            BotFace(color: Theme.bots[1]).frame(width: 118).rotationEffect(.degrees(6)).padding(.top, 38)
            BotFace(color: Theme.bots[2]).frame(width: 132).rotationEffect(.degrees(12)).padding(.top, -8)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 176, alignment: .top)
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
                .foregroundStyle(.white)
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
