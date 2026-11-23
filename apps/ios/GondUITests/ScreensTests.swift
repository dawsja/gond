import XCTest

final class ScreensTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    func testConversationMenuReceivesTapsOverBotDetails() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["GOND_SCREENS_SERVER"], let cookie = env["GOND_SCREENS_COOKIE"], let thread = env["GOND_SCREENS_THREAD"] else {
            throw XCTSkip("This test needs the seeded iPhone screenshot server")
        }

        let app = XCUIApplication()
        app.launchEnvironment = ["GOND_SCREENS_SERVER": server, "GOND_SCREENS_COOKIE": cookie, "GOND_SCREENS_PATH": "/app/t/\(thread)"]
        app.launch()
        defer { app.terminate() }

        let more = app.buttons["chrome.more"]
        guard more.waitForExistence(timeout: 60) else {
            XCTFail("The conversation menu never became available")
            return
        }
        let details = app.buttons["chrome.details"].frame
        let back = app.buttons["chrome.back"].frame
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let edit = app.buttons["Edit profile"]

        more.tap()
        guard edit.waitForExistence(timeout: 5) else {
            XCTFail("The conversation menu did not open")
            return
        }
        origin.withOffset(CGVector(dx: back.midX, dy: back.midY)).tap()
        XCTAssertFalse(edit.exists, "An outside tap should dismiss the menu")
        XCTAssertTrue(more.exists, "The back button behind the menu should not navigate")

        more.tap()
        guard edit.waitForExistence(timeout: 5) else {
            XCTFail("The conversation menu did not reopen")
            return
        }
        let overlap = edit.frame.intersection(details)
        guard !overlap.isEmpty else {
            XCTFail("Edit profile must overlap the bot details pill for this test")
            return
        }
        origin.withOffset(CGVector(dx: overlap.midX, dy: overlap.midY)).tap()
        XCTAssertTrue(app.webViews.staticTexts["Edit Patch"].waitForExistence(timeout: 5))
    }

    func testPDFPreviewClosesBackToConversation() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["GOND_SCREENS_SERVER"], let cookie = env["GOND_SCREENS_COOKIE"], let thread = env["GOND_SCREENS_THREAD"] else {
            throw XCTSkip("This test needs the seeded iPhone screenshot server")
        }

        let app = XCUIApplication()
        app.launchEnvironment = ["GOND_SCREENS_SERVER": server, "GOND_SCREENS_COOKIE": cookie, "GOND_SCREENS_PATH": "/app/t/\(thread)"]
        app.launch()
        defer { app.terminate() }

        let attachment = app.webViews.links["Open backup-report.pdf"]
        guard attachment.waitForExistence(timeout: 60) else {
            XCTFail("The PDF attachment never became available")
            return
        }
        attachment.tap()

        let close = app.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "Close"])).firstMatch
        guard close.waitForExistence(timeout: 15) else {
            XCTFail("The PDF viewer should have a close button")
            return
        }
        close.tap()
        let more = app.buttons["chrome.more"]
        let headerReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == YES AND hittable == YES"), object: more)
        XCTAssertEqual(XCTWaiter.wait(for: [headerReady], timeout: 5), .completed, "The conversation header should be usable again")
        XCTAssertTrue(attachment.exists, "Closing the preview should return to the same chat")
    }

    func testScreens() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["GOND_SCREENS_SERVER"], let cookie = env["GOND_SCREENS_COOKIE"], let thread = env["GOND_SCREENS_THREAD"] else {
            throw XCTSkip("Screenshots run against a seeded Gond: bun run screens")
        }
        let folder = env["GOND_SCREENS_DIR"].map { URL(fileURLWithPath: $0) }
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
                app.terminate()
                app.launch()
                _ = details.waitForExistence(timeout: 60)
                Thread.sleep(forTimeInterval: 2)
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

            app.launchEnvironment["GOND_SCREENS_PATH"] = "/app/settings/appearance"
            app.launch()
            _ = app.buttons["settings.back"].waitForExistence(timeout: 60)
            Thread.sleep(forTimeInterval: 2)
            shot("12-settings")
            app.terminate()

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
