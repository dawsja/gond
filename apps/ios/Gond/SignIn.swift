import AuthenticationServices
import CryptoKit
import UIKit

/*
 * The provider's sign-in runs in Safari's own sign-in sheet: a web view
 * can't use passkeys, and many providers refuse to sign in inside one. The
 * sheet gets only a hash of a verifier kept here; the API sends back a
 * one-time code that is good only with it (apps/api/src/mobile-sign-in.ts),
 * which the web view redeems for its own session.
 */
@MainActor
final class SignIn: NSObject {
    private var session: ASWebAuthenticationSession?

    /// `finish` gets the path to load in the web view: the redeem, or the sign-in page with an error.
    func start(server: String, next: String?, finish: @escaping (String) -> Void) {
        let verifier = Self.base64url(Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }))
        let challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        guard let url = URL(string: "\(server)/api/mobile-sign-in/start?challenge=\(challenge)&app=ios") else { return }
        let next = next ?? "/app"
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "gond") { [weak self] callback, error in
            Task { @MainActor in
                self?.session = nil
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { return }
                let parts = callback.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
                guard parts?.host == "sign-in", let code = parts?.queryItems?.first(where: { $0.name == "code" })?.value else {
                    finish("/login?error=oidc")
                    return
                }
                var redeem = URLComponents()
                redeem.queryItems = [URLQueryItem(name: "code", value: code), URLQueryItem(name: "verifier", value: verifier), URLQueryItem(name: "next", value: next)]
                finish("/api/mobile-sign-in/redeem?\(redeem.percentEncodedQuery ?? "")")
            }
        }
        session.presentationContextProvider = self
        // The provider's own sign-in in Safari is reused, so a passkey or a remembered account works.
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

extension SignIn: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
