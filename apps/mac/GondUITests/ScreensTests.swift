import XCTest

/// Screenshots of the app's own glass over a seeded Gond, in light and dark, for review
/// (.github/workflows/mac-screens.yml). Skipped anywhere the job hasn't set the server up.
final class ScreensTests: XCTestCase {
    private var app: XCUIApplication!
    private var appearance = "light"
    private var folder: URL?

    override func setUp() {
        continueAfterFailure = true
    }

    func testScreens() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["GOND_SCREENS_SERVER"], let cookie = env["GOND_SCREENS_COOKIE"], let thread = env["GOND_SCREENS_THREAD"] else {
            throw XCTSkip("Screenshots run in CI against a seeded Gond")
        }
        appearance = env["GOND_SCREENS_APPEARANCE"] ?? "light"
        folder = env["GOND_SCREENS_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
        let base = ["GOND_SCREENS_SERVER": server, "GOND_SCREENS_COOKIE": cookie, "GOND_SCREENS_APPEARANCE": appearance]

        // A conversation: the toolbar, the composer, the menu, a confirm, the sidebar searching.
        launch(base, path: "/app/t/\(thread)")
        if wait(for: "composer.field", timeout: 60) {
            Thread.sleep(forTimeInterval: 2)
            shot("conversation")

            let more = element("chrome.more")
            if more.waitForExistence(timeout: 10) {
                more.click()
                shot("menu")
                let delete = app.menuItems["Delete bot"]
                if delete.waitForExistence(timeout: 3) {
                    delete.click()
                    let cancel = app.sheets.buttons["Cancel"].firstMatch
                    if cancel.waitForExistence(timeout: 5) {
                        shot("confirm")
                        cancel.click()
                    } else {
                        print("[screens] no confirm came; closing whatever opened")
                        app.typeKey(.escape, modifierFlags: [])
                    }
                } else {
                    app.typeKey(.escape, modifierFlags: [])
                }
                Thread.sleep(forTimeInterval: 1)
            } else {
                print("[screens] the conversation's menu never showed")
            }

            let search = element("sidebar.search")
            if search.waitForExistence(timeout: 10) {
                search.click()
                search.typeText("net")
                Thread.sleep(forTimeInterval: 1.5)
                shot("search")
                search.typeKey(.escape, modifierFlags: [])
            } else {
                print("[screens] the sidebar's search never showed")
            }
        } else {
            print("[screens] the conversation's composer never showed")
            shot("conversation-missing")
            XCTFail("The conversation's composer never showed")
        }
        app.terminate()

        // A room: the bots to @mention sit on the composer.
        if let room = env["GOND_SCREENS_ROOM"], !room.isEmpty {
            launch(base, path: "/app/t/\(room)")
            if wait(for: "composer.field", timeout: 60) {
                Thread.sleep(forTimeInterval: 2.5)
                shot("room")
            } else {
                print("[screens] the room's composer never showed")
            }
            app.terminate()
        }

        // Settings: its sections in the sidebar.
        launch(base, path: "/app/settings/appearance")
        if !wait(for: "sidebar.back", timeout: 60) { print("[screens] Settings' sections never showed") }
        Thread.sleep(forTimeInterval: 2)
        shot("settings")
        app.terminate()

        // Connect.
        var connect = base
        connect["GOND_SCREENS_CONNECT"] = "1"
        launch(connect, path: nil)
        if !wait(for: "connect.address", timeout: 20) { print("[screens] Connect never showed") }
        Thread.sleep(forTimeInterval: 1)
        shot("connect")
        app.terminate()
    }

    private func launch(_ env: [String: String], path: String?) {
        app = XCUIApplication()
        var environment = env
        if let path { environment["GOND_SCREENS_PATH"] = path }
        app.launchEnvironment = environment
        app.launch()
        app.activate()
    }

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func wait(for id: String, timeout: TimeInterval) -> Bool {
        element(id).waitForExistence(timeout: timeout)
    }

    /// The window as it is now, kept with the run and, for the job, written out as `<name>-<appearance>.png`.
    private func shot(_ step: String) {
        Thread.sleep(forTimeInterval: 1.2)
        let name = "\(step)-\(appearance)"
        let window = app.windows.firstMatch
        let screenshot = window.exists ? window.screenshot() : XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder { try? screenshot.pngRepresentation.write(to: folder.appendingPathComponent("\(name).png")) }
        print("[screens] \(name)")
    }
}
