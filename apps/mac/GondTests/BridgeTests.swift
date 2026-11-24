import JavaScriptCore
import XCTest
@testable import Gond

final class BridgeTests: XCTestCase {
    private let server = "https://gond.example.com"

    private func page(origin: String, insetTop: CGFloat = 52) -> JSContext {
        let context: JSContext = JSContext()
        _ = context.evaluateScript("""
        var window = this;
        var posted = [];
        var listeners = {};
        var location = { origin: \(String(reflecting: origin)) };
        var properties = {};
        var document = { documentElement: { style: { setProperty: function (name, value) { properties[name] = value; } } } };
        window.addEventListener = function (name, listener) { listeners[name] = listener; };
        window.webkit = { messageHandlers: { gondMac: { postMessage: function (message) { posted.push(JSON.stringify(message)); } } } };
        """)
        _ = context.evaluateScript(WebShell.bridgeScript(server: server, version: "1.2.3", notifications: "denied", insetTop: insetTop))
        return context
    }

    func testTheBridgeIsDefinedOnlyOnTheServersOrigin() {
        XCTAssertEqual(page(origin: server).evaluateScript("typeof window.gondMac").toString(), "object")
        XCTAssertEqual(page(origin: "https://accounts.example.com").evaluateScript("typeof window.gondMac").toString(), "undefined")
        XCTAssertEqual(page(origin: "http://gond.example.com").evaluateScript("typeof window.gondMac").toString(), "undefined")
        XCTAssertEqual(page(origin: "https://accounts.example.com").evaluateScript("Object.keys(properties).length").toInt32(), 0)
    }

    func testThePageReadsWhatTheAppWroteIn() {
        let context = page(origin: server)
        XCTAssertEqual(context.evaluateScript("gondMac.platform()").toString(), "macos")
        XCTAssertEqual(context.evaluateScript("gondMac.version()").toString(), "1.2.3")
        XCTAssertEqual(context.evaluateScript("gondMac.features().join(',')").toString(), "scale,sidebar")
        XCTAssertEqual(context.evaluateScript("gondMac.notificationsState()").toString(), "denied")
        XCTAssertEqual(context.evaluateScript("properties['--shell-inset-top']").toString(), "52.0px")
        _ = context.evaluateScript("listeners['gond:notifications-state']({ detail: 'granted' })")
        XCTAssertEqual(context.evaluateScript("gondMac.notificationsState()").toString(), "granted")
    }

    func testCallsPostTheirArgumentsAsStrings() {
        let context = page(origin: server)
        _ = context.evaluateScript("gondMac.notify('Patch', 'Done', '/app/t/1', 7); gondMac.sidebar(); gondMac.showDownload('3')")
        let posted = context.evaluateScript("posted").toArray() as? [String] ?? []
        XCTAssertEqual(posted.count, 3)
        XCTAssertEqual(posted.first, #"{"action":"notify","args":["Patch","Done","/app/t/1","7"]}"#)
        XCTAssertEqual(posted[safe: 1], #"{"action":"sidebar","args":["null"]}"#)
        XCTAssertEqual(posted[safe: 2], #"{"action":"showDownload","args":[3]}"#)
    }

    func testAServerOrVersionWithQuotesCantBreakOutOfTheScript() {
        let script = WebShell.bridgeScript(server: "https://x.example.com\"; alert(1); \"", version: "1\"); alert(2); (\"", notifications: "prompt", insetTop: 0)
        let context: JSContext = JSContext()
        _ = context.evaluateScript("var window = this; var alerted = false; function alert() { alerted = true; } var location = { origin: 'https://x.example.com' }; window.addEventListener = function () {};")
        _ = context.evaluateScript(script)
        XCTAssertFalse(context.evaluateScript("alerted").toBool())
        XCTAssertNil(context.exception)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
