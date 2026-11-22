import UIKit
import XCTest
@testable import Gond

final class CameraPhotoTests: XCTestCase {
    func testPhotoNameUsesTimestampInPosixFormat() {
        let date = Date(timeIntervalSince1970: 1_795_306_530)
        XCTAssertEqual(CameraPhoto.name(for: date, timeZone: TimeZone(secondsFromGMT: 0)!), "Photo-20261122-001530.jpg")
    }

    func testJpegDataEncodesImageToJpeg() {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let image = renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let data = CameraPhoto.jpegData(from: image)
        XCTAssertNotNil(data)
        XCTAssertEqual(data?.prefix(2), Data([0xFF, 0xD8]))
    }
}
