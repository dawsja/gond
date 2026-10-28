import XCTest
@testable import Gond

/** The vector is made by the server's own sealNotice and answerSignature (apps/api/src/phone-push.ts), as in the Android app's PushCryptoTest. */
final class PushCryptoTests: XCTestCase {
    private let key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    private let sealed = "CQkJCQkJCQkJCQkJXKfytoTB7UPUC79Ug8iZ_YTfAJhRmtXsTcwpwqxWO1iXiommzHAGMgrByTR-Fsy1DCSx4D3g8X9HQyPjN3FYtE4L1z-rWzozbDDp9ALXxZX4YXvG8fI"

    func testOpensWhatTheServerSealed() {
        XCTAssertEqual(PushCrypto.open(key: key, sealed: sealed), #"{"v":1,"title":"Pocket","body":"Done.","url":"/app/t/t_1","tag":"t_1"}"#)
    }

    func testRefusesAnotherKeyOrATamperedNotice() {
        XCTAssertNil(PushCrypto.open(key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg", sealed: sealed))
        XCTAssertNil(PushCrypto.open(key: key, sealed: String(sealed.dropLast(4)) + "AAAA"))
        XCTAssertNil(PushCrypto.open(key: key, sealed: "short"))
    }

    func testSignsAnAnswerAsTheServerChecksIt() {
        XCTAssertEqual(PushCrypto.sign(key: key, device: "dev_1", at: "1761700000000", approvalId: "ap_1", decision: "allow"), "75ae351e3b318a8a3d3c9dcd3815ca9247fb5dc75483b40416b3da4782f06ef4")
    }

    func testANoticeOpensOnlyPathsOnTheGondAndKnowsAWithdrawal() {
        let notice = PhoneNotice(json: #"{"v":1,"title":"Errand","body":"Place this order?","url":"https://evil.example/x","tag":"card-ap_1","card":{"id":"ap_1","allow":"Place order","deny":"Not yet"}}"#)
        XCTAssertEqual(notice?.url, "/app")
        XCTAssertEqual(notice?.card?.id, "ap_1")
        XCTAssertNil(notice?.withdraw)
        XCTAssertEqual(PhoneNotice(json: #"{"v":1,"withdraw":"card-ap_1"}"#)?.withdraw, "card-ap_1")
    }
}
