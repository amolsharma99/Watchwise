import Foundation
import XCTest
@testable import WatchwiseIntegrations

final class BrowserEventDecoderTests: XCTestCase {
    private let referenceNow = Date(timeIntervalSince1970: 1_800_000_000)
    private func decoder() -> BrowserEventDecoder {
        let now = referenceNow
        return BrowserEventDecoder(now: { now })
    }
    private var valid: [String: Any] {
        [
            "schemaVersion": 1, "title": "A useful explanation",
            "url": "https://www.youtube.com/watch?v=abc", "site": "www.youtube.com",
            "duration": 600.0, "position": 42.0, "playbackRate": 1.25,
            "state": "playing", "occurredAtMilliseconds": 1_800_000_000_000.0,
            "documentVisible": true
        ]
    }

    func testAcceptsMinimalSchema() throws {
        let data = try JSONSerialization.data(withJSONObject: valid)
        let event = try decoder().decode(data)
        XCTAssertEqual(event.position, 42)
        XCTAssertEqual(event.site, "www.youtube.com")
        XCTAssertEqual(event.state, .playing)
        XCTAssertEqual(try event.playbackEvent(sessionID: UUID()).state, .playing)
    }

    func testRejectsUnknownPageData() throws {
        var payload = valid
        payload["pageText"] = "private transcript"
        XCTAssertThrowsError(try decoder().decode(JSONSerialization.data(withJSONObject: payload)))
    }

    func testRejectsHiddenDocumentTelemetry() throws {
        var payload = valid
        payload["documentVisible"] = false
        XCTAssertThrowsError(try decoder().decode(JSONSerialization.data(withJSONObject: payload)))
    }

    func testTopLevelSiteIsValidatedAndUsedForAttribution() throws {
        var payload = valid
        payload["pageSite"] = "news.example.com"
        let event = try decoder().decode(JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(event.pageSite, "news.example.com")
        XCTAssertEqual(try event.playbackEvent(sessionID: UUID()).site, "news.example.com")

        payload["pageSite"] = "localhost"
        XCTAssertThrowsError(try decoder().decode(JSONSerialization.data(withJSONObject: payload)))
    }

    func testRejectsUnsafeURLs() throws {
        for value in ["http://youtube.com/watch?v=x", "https://localhost/video", "https://192.168.1.2/video", "https://user:pass@example.com/video"] {
            var payload = valid
            payload["url"] = value
            payload["site"] = URL(string: value)?.host ?? "localhost"
            XCTAssertThrowsError(try decoder().decode(JSONSerialization.data(withJSONObject: payload)), value)
        }
    }

    func testRejectsOutOfRangeTelemetry() throws {
        var payload = valid
        payload["playbackRate"] = 20
        XCTAssertThrowsError(try decoder().decode(JSONSerialization.data(withJSONObject: payload)))
    }

    func testRejectsTimestampBeyondAllowedFutureSkew() throws {
        var payload = valid
        payload["occurredAtMilliseconds"] = (referenceNow.timeIntervalSince1970 + 301) * 1000
        let now = referenceNow
        XCTAssertThrowsError(try BrowserEventDecoder(now: { now }, maximumFutureSkew: 300).decode(JSONSerialization.data(withJSONObject: payload)))
    }
}
