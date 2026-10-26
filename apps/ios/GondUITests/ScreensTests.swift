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
        // The job sets the simulator's appearance and runs this once for each.
        let name = env["GOND_SCREENS_APPEARANCE"] ?? "light"
        do {
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

            let more = app.buttons["chrome.more"]
            _ = more.waitForExistence(timeout: 10)
            more.tap()
            if !app.buttons["Delete bot"].waitForExistence(timeout: 3) {
                print("[screens] the menu didn't open on the first tap; trying again")
                more.tap()
            }
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

            let picture = app.webViews.buttons["View backyard.png"]
            let pictureFrame = picture.waitForExistence(timeout: 10) ? picture.frame : .zero
            let bubble = app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS 'All three finished'")).firstMatch
            if bubble.waitForExistence(timeout: 10) {
                bubble.press(forDuration: 1.1)
                shot("4-message")
                // Reply: the quote sits on the composer.
                if app.buttons["Reply"].waitForExistence(timeout: 3) {
                    app.buttons["Reply"].tap()
                    shot("4b-reply")
                    let drop = app.buttons["Don't reply to it"]
                    if drop.waitForExistence(timeout: 3) { drop.tap() }
                } else {
                    // The dimmed page under the menu; a tap in the status bar goes to iOS, not the app.
                    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.88)).tap()
                }
                Thread.sleep(forTimeInterval: 1)
                // Copy text: its "Copied." is the app's toast.
                bubble.press(forDuration: 1.1)
                if app.buttons["Copy text"].waitForExistence(timeout: 3) {
                    app.buttons["Copy text"].tap()
                    Thread.sleep(forTimeInterval: 0.3)
                    shot("4c-toast")
                    Thread.sleep(forTimeInterval: 3)
                }
            }

            if pictureFrame != .zero {
                let started = Date()
                // The same spot on the screen as before the long press, whatever the page's accessibility says now.
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: pictureFrame.midX, dy: pictureFrame.midY)).tap()
                var opened = false
                while !opened && Date().timeIntervalSince(started) < 20 {
                    opened = app.navigationBars.count > 0 || app.buttons["Done"].exists || app.buttons["Close"].exists
                    if !opened { Thread.sleep(forTimeInterval: 0.25) }
                }
                print("[screens] Quick Look \(opened ? "opened" : "never opened") after \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
                shot("5-picture")
                Thread.sleep(forTimeInterval: 3)
                shot("5b-picture-later")
                var closed = false
                for label in ["Done", "Close"] where app.buttons[label].exists {
                    app.buttons[label].tap()
                    closed = true
                    break
                }
                if !closed { app.swipeDown(velocity: .fast) }
                Thread.sleep(forTimeInterval: 1.5)
            }

            let field = app.textFields["chrome.field"].exists ? app.textFields["chrome.field"] : app.textViews["chrome.field"]
            if field.waitForExistence(timeout: 5) {
                field.tap()
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
                Thread.sleep(forTimeInterval: 0.5)
                field.typeText("Can you also check @")
                Thread.sleep(forTimeInterval: 1)
                print("[screens] the field holds \"\(field.value as? String ?? "?")\"")
                shot("6-typing")
                // Left in the field it would be the next run's draft.
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 24))
            }
            details.tap()
            shot("7-details")
            app.terminate()

            // The Chats screen: its header's buttons, and a long press on a row.
            app.launchEnvironment["GOND_SCREENS_PATH"] = "/app"
            app.launch()
            let search = app.buttons["chats.search"]
            XCTAssertTrue(search.waitForExistence(timeout: 60), "the Chats header never showed")
            Thread.sleep(forTimeInterval: 2)
            shot("8-chats")
            // The second chat in the list (Patch, under the room), by where it sits.
            do {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.30)).press(forDuration: 1.1)
                shot("9-chats-menu")
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.88)).tap()
                Thread.sleep(forTimeInterval: 1)
            }
            app.buttons["chats.new"].tap()
            shot("10-chats-new")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.88)).tap()
            Thread.sleep(forTimeInterval: 1)
            search.tap()
            let query = app.textFields["chats.query"]
            if query.waitForExistence(timeout: 5) {
                query.typeText("sen")
                shot("11-search")
            }
            app.terminate()

            // A Settings page: its back button.
            app.launchEnvironment["GOND_SCREENS_PATH"] = "/app/settings/appearance"
            app.launch()
            _ = app.buttons["settings.back"].waitForExistence(timeout: 60)
            Thread.sleep(forTimeInterval: 2)
            shot("12-settings")
            app.terminate()

            // A room: the bots to @mention sit on the composer.
            if let room = env["GOND_SCREENS_ROOM"], !room.isEmpty {
                app.launchEnvironment["GOND_SCREENS_PATH"] = "/app/t/\(room)"
                app.launch()
                _ = app.buttons["chrome.details"].waitForExistence(timeout: 60)
                Thread.sleep(forTimeInterval: 2.5)
                shot("13-room")
                app.terminate()
            }
        }
    }
}
