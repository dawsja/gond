import XCTest
@testable import Gond

final class NativeStateTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testAWholeSidebarReadsAsThePageSentIt() throws {
        let state = try decode(SidebarState.self, """
        {"faces":{"b1":"data:image/png;base64,AA=="},"mode":"chats","title":"Gond","covered":false,"query":"",
         "loaded":true,"empty":false,
         "pinned":[{"id":"t1","path":"/app/t/t1","title":"Patch","face":"b1","active":true,"working":false,"unread":null,"color":"#2f6fd6","menu":[]}],
         "rows":[{"id":"t2","path":"/app/t/t2","title":"Sentry","job":"Systems Administrator","pinned":false,"time":"9:41","preview":"All three finished",
                  "previewKind":"text","unread":"you","color":"#1f9e8f","face":"b2","active":false,"working":true,
                  "menu":[[{"id":"pin","label":"Pin","symbol":"pin"}],[{"id":"delete","label":"Delete bot","symbol":"trash","destructive":true}]]}],
         "hits":[],"look":{"label":"Worth a look","count":2},
         "newItems":[{"id":"new-bot","label":"New bot","symbol":"sparkles"}],
         "me":{"name":"Sam","face":null,"initial":"S","profile":null,"active":false},
         "profileMenu":[[{"id":"settings","label":"Settings","symbol":"gearshape"}]],
         "call":{"label":"On a call with Patch","since":1700000000000,"muted":true,"color":"#2f6fd6"},
         "sections":[]}
        """)
        XCTAssertFalse(state.settings)
        XCTAssertEqual(state.faces["b1"], "data:image/png;base64,AA==")
        XCTAssertEqual(state.pinned.first?.active, true)
        XCTAssertEqual(state.rows.first?.unread, "you")
        XCTAssertEqual(state.rows.first?.menu.count, 2)
        XCTAssertEqual(state.rows.first?.menu.last?.first?.destructive, true)
        XCTAssertEqual(state.rows.first?.menu.first?.first?.destructive, false)
        XCTAssertEqual(state.look?.count, 2)
        XCTAssertNil(state.me.face)
        XCTAssertEqual(state.call?.muted, true)
    }

    func testASidebarMissingFieldsStillDraws() throws {
        let state = try decode(SidebarState.self, #"{"mode":"settings","sections":[{"label":"You","items":[{"id":"account","label":"Account","symbol":"person","path":"/app/settings/account","active":true}]}]}"#)
        XCTAssertTrue(state.settings)
        XCTAssertEqual(state.title, "Gond")
        XCTAssertTrue(state.rows.isEmpty)
        XCTAssertEqual(state.me, SidebarState.Me.none)
        XCTAssertEqual(state.sections.first?.items.first?.path, "/app/settings/account")
    }

    func testAFieldOfTheWrongKindFallsBackAlone() throws {
        let state = try decode(SidebarState.self, #"{"mode":"chats","covered":"yes","faces":{"a":null,"b":"data:x"},"rows":[{"id":"t1","time":5,"title":"Patch"}],"look":"soon"}"#)
        XCTAssertFalse(state.covered)
        XCTAssertEqual(state.faces, ["b": "data:x"])
        XCTAssertEqual(state.rows.first?.title, "Patch")
        XCTAssertEqual(state.rows.first?.time, "")
        XCTAssertEqual(state.rows.first?.path, "/app/t/t1")
        XCTAssertNil(state.look)
    }

    func testChromeWithoutNewerFieldsKeepsItsComposer() throws {
        let state = try decode(ChromeState.self, #"{"thread":"t1","title":"Patch","menu":[],"composer":{"text":"hi","textRev":3,"canSend":true}}"#)
        XCTAssertEqual(state.composer.text, "hi")
        XCTAssertEqual(state.composer.textRev, 3)
        XCTAssertTrue(state.composer.canSend)
        XCTAssertEqual(state.composer.voice, "off")
        XCTAssertTrue(state.mentions.isEmpty)
        XCTAssertNil(state.call)
        XCTAssertNil(state.column)
    }

    func testAPhonesChatsHeaderIsntAConversation() {
        XCTAssertThrowsError(try decode(ChromeState.self, #"{"screen":"chats","initial":"D","canNewRoom":true,"covered":false}"#))
    }
}
