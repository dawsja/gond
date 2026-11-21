import SwiftUI

/// The app's one screen of its own: where your Gond is. Everything after it is your Gond's web app.
struct ConnectView: View {
    @ObservedObject var model: AppModel
    @FocusState private var typing: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image("BrandMark").resizable().frame(width: 28, height: 28)
                    Text("Gond").font(.system(size: 18, weight: .bold))
                }
                .accessibilityElement(children: .combine)
                // The team stands above the words, never behind them.
                team.padding(.top, 28)
                Text("Where is your Gond?")
                    .font(.system(size: 34, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 32)
                Text("Enter the address you open Gond at in your browser.")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
                form.padding(.top, 24)
                if model.canGoBack, let server = model.server {
                    Button("Back to \(server)") { model.backToServer() }
                        .buttonStyle(.plain)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.foreground)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 18)
                        .keyboardShortcut(.cancelAction)
                }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 28)
            .padding(.vertical, 40)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.background.ignoresSafeArea())
        .onAppear { typing = true }
    }

    /// Three bots' faces, standing together like the team you're about to reach.
    private var team: some View {
        HStack(alignment: .top, spacing: -14) {
            BotFace(hex: Theme.bots[0]).frame(width: 150).rotationEffect(.degrees(-10))
            BotFace(hex: Theme.bots[1]).frame(width: 118).rotationEffect(.degrees(6)).padding(.top, 38)
            BotFace(hex: Theme.bots[2]).frame(width: 132).rotationEffect(.degrees(12)).padding(.top, -8)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 176, alignment: .top)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Address")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.muted)
                .padding(.leading, 6)
            TextField("https://gond.example.com", text: $model.address)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .focused($typing)
                .onSubmit(connect)
                .onChange(of: model.address) { model.connectError = nil }
                .disabled(model.connecting)
                .font(.system(size: 15))
                .padding(.horizontal, 18)
                .frame(height: 44)
                .glassControl(in: Capsule(), interactive: false)
                .accessibilityIdentifier("connect.address")
            if let error = model.connectError {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
            }
            Button(action: connect) {
                HStack(spacing: 8) {
                    if model.connecting { ProgressView().controlSize(.small) }
                    Text(model.connecting ? "Connecting…" : "Connect").font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Capsule())
                .prominentGlass(in: Capsule(), tint: Theme.tint)
            }
            .buttonStyle(.plain)
            .disabled(model.connecting)
            .padding(.top, 6)
            .accessibilityIdentifier("connect.go")
        }
        .padding(18)
        .glassControl(in: RoundedRectangle(cornerRadius: 30, style: .continuous), interactive: false)
    }

    private func connect() {
        Task { await model.connect() }
    }
}
