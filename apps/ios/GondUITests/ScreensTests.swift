import XCTest

/// Screenshots of the app's own glass over a seeded Gond, in light and dark, for review
/// (.github/workflows/ios-screens.yml). Skipped anywhere the job hasn't set the server up.
final class ScreensTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    func testScreens() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["GOND_SCREENS_SERVER"], let cookie = env["GOND_SCREENS_COOKIE"], let thread = env["GOND_SCREENS_THREAD"] else {
            throw XCTSkip("Screenshots run in CI against a seeded Gond")
        }
        let folder = env["GOND_SCREENS_DIR"].map { URL(fileURLWithPath: $0) }
        for appearance in [XCUIDevice.Appearance.light, .dark] {
            XCUIDevice.shared.appearance = appearance
            let name = appearance == .dark ? "dark" : "light"
            let app = XCUIApplication()
            app.launchEnvironment = ["GOND_SCREENS_SERVER": server, "GOND_SCREENS_COOKIE": cookie, "GOND_SCREENS_PATH": "/app/t/\(thread)"]
            app.launch()
            func shot(_ step: String) {
                Thread.sleep(forTimeInterval: 1.2)
                let screenshot = XCUIScreen.main.screenshot()
                let attachment = XCTAttachment(screenshot: screenshot)
                attachment.name = "\(name)-\(step)"
                attachment.lifetime = .keepAlways
                add(attachment)
                if let folder { try? screenshot.pngRepresentation.write(to: folder.appendingPathComponent("\(name)-\(step).png")) }
            }

            let details = app.buttons["chrome.details"]
            XCTAssertTrue(details.waitForExistence(timeout: 60), "the conversation's header never showed")
            Thread.sleep(forTimeInterval: 2)
            shot("1-conversation")

            app.buttons["chrome.more"].tap()
            shot("2-menu")
            let delete = app.buttons["Delete bot"]
            if delete.waitForExistence(timeout: 5) {
                delete.tap()
                shot("3-confirm")
                let cancel = app.alerts.buttons["Cancel"]
                if cancel.waitForExistence(timeout: 5) { cancel.tap() }
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }

            let bubble = app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS 'All three finished'")).firstMatch
            if bubble.waitForExistence(timeout: 10) {
                bubble.press(forDuration: 1.1)
                shot("4-message")
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
            }

            let picture = app.webViews.buttons["View backyard.png"]
            if picture.waitForExistence(timeout: 10) {
                picture.tap()
                Thread.sleep(forTimeInterval: 2)
                shot("5-picture")
                for label in ["Done", "Close"] where app.buttons[label].exists {
                    app.buttons[label].tap()
                    break
                }
                Thread.sleep(forTimeInterval: 1)
            }

            let field = app.textFields["chrome.field"].exists ? app.textFields["chrome.field"] : app.textViews["chrome.field"]
            if field.waitForExistence(timeout: 5) {
                field.tap()
                field.typeText("Can you also check @")
                shot("6-typing")
            }
            details.tap()
            shot("7-details")
            app.terminate()
        }
    }
}
