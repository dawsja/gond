import XCTest
@testable import Gond

/** Mirrors apps/android/.../ServerUrlTest.kt and the desktop's server-url tests, so every app reads an address the same way. */
final class ServerURLTests: XCTestCase {
    func testAnAddressWithASchemeIsTriedAsGivenWithoutItsPath() throws {
        XCTAssertEqual(try ServerURL.candidates("https://gond.example.com/app/t/123"), ["https://gond.example.com"])
        XCTAssertEqual(try ServerURL.candidates("http://192.168.1.20:3000/"), ["http://192.168.1.20:3000"])
    }

    func testAPublicHostWithoutASchemeTriesHttpsFirst() throws {
        XCTAssertEqual(try ServerURL.candidates("gond.example.com"), ["https://gond.example.com", "http://gond.example.com"])
    }

    func testThisMachineAndPrivateNetworksTryHttpFirst() throws {
        XCTAssertEqual(try ServerURL.candidates("localhost:3000"), ["http://localhost:3000", "https://localhost:3000"])
        XCTAssertEqual(try ServerURL.candidates("192.168.1.20:3000"), ["http://192.168.1.20:3000", "https://192.168.1.20:3000"])
        XCTAssertEqual(try ServerURL.candidates("gond.local"), ["http://gond.local", "https://gond.local"])
        XCTAssertEqual(try ServerURL.candidates("nas"), ["http://nas", "https://nas"])
    }

    func testDefaultPortsAreDroppedAndOthersKept() throws {
        XCTAssertEqual(try ServerURL.candidates("http://gond.example.com:80"), ["http://gond.example.com"])
        XCTAssertEqual(try ServerURL.candidates("https://gond.example.com:8443"), ["https://gond.example.com:8443"])
    }

    func testBadInputNamesItsReason() {
        XCTAssertEqual(reason("  "), .empty)
        XCTAssertEqual(reason("ftp://gond.example.com"), .scheme)
        XCTAssertEqual(reason("https://me:secret@gond.example.com"), .credentials)
        XCTAssertEqual(reason("http://"), .invalid)
    }

    func testSameOriginComparesSchemeHostAndPort() {
        XCTAssertTrue(ServerURL.sameOrigin("https://gond.example.com/app", "https://gond.example.com"))
        XCTAssertTrue(ServerURL.sameOrigin("https://GOND.example.com:443/x", "https://gond.example.com"))
        XCTAssertFalse(ServerURL.sameOrigin("http://gond.example.com/app", "https://gond.example.com"))
        XCTAssertFalse(ServerURL.sameOrigin("https://gond.example.com:8443/", "https://gond.example.com"))
        XCTAssertFalse(ServerURL.sameOrigin("not a url", "https://gond.example.com"))
        XCTAssertFalse(ServerURL.sameOrigin(nil as String?, "https://gond.example.com"))
    }

    func testAPageOriginFromWebKitMatchesTheSavedServer() {
        XCTAssertEqual(ServerURL.origin(scheme: "https", host: "Gond.Example.com", port: 0), "https://gond.example.com")
        XCTAssertEqual(ServerURL.origin(scheme: "http", host: "192.168.1.20", port: 3000), "http://192.168.1.20:3000")
        XCTAssertEqual(ServerURL.origin(scheme: "http", host: "::1", port: 8080), "http://[::1]:8080")
    }

    private func reason(_ input: String) -> ServerURL.Invalid? {
        do {
            _ = try ServerURL.candidates(input)
            XCTFail("expected \(input) to be rejected")
            return nil
        } catch let failure as ServerURL.Invalid {
            return failure
        } catch {
            XCTFail("unexpected \(error)")
            return nil
        }
    }
}
