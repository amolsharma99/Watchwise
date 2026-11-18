import Foundation
import XCTest
@testable import WatchwiseIntegrations

final class NativeMessagingTests: XCTestCase {
    func testFramingRoundTripWithoutJavaScript() throws {
        let payload = Data(#"{"ok":true}"#.utf8)
        let framed = try NativeMessageFramer.frame(payload)
        XCTAssertEqual(Array(framed.prefix(4)), [11, 0, 0, 0])
        XCTAssertEqual(try NativeMessageFramer.decodeSingleFrame(framed), payload)
    }

    func testFramingRejectsTruncatedAndOversizedInput() throws {
        XCTAssertThrowsError(try NativeMessageFramer.decodeSingleFrame(Data([3, 0, 0])))
        XCTAssertThrowsError(try NativeMessageFramer.frame(Data(repeating: 1, count: 65), maximumSize: 64))
        XCTAssertThrowsError(try NativeMessageFramer.decodeSingleFrame(Data([100, 0, 0, 0]), maximumSize: 64))
    }

    func testStableSessionsRollAfterEndOrGap() throws {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let decoder = BrowserEventDecoder(now: { base.addingTimeInterval(10_000) })
        func event(state: String, offset: TimeInterval) throws -> BrowserPlaybackEvent {
            let json: [String: Any] = [
                "schemaVersion": 1, "title": "Video", "url": "https://www.youtube.com/watch?v=x",
                "site": "www.youtube.com", "duration": 3600.0, "position": offset,
                "playbackRate": 1.0, "state": state,
                "occurredAtMilliseconds": (base.timeIntervalSince1970 + offset) * 1000,
                "documentVisible": true
            ]
            return try decoder.decode(JSONSerialization.data(withJSONObject: json))
        }
        var tracker = BrowserSessionTracker(inactivityGap: 600)
        let first = tracker.sessionID(for: try event(state: "playing", offset: 0))
        XCTAssertEqual(tracker.sessionID(for: try event(state: "heartbeat", offset: 30)), first)
        XCTAssertEqual(tracker.sessionID(for: try event(state: "ended", offset: 60)), first)
        XCTAssertNotEqual(tracker.sessionID(for: try event(state: "playing", offset: 61)), first)

        var gapTracker = BrowserSessionTracker(inactivityGap: 600)
        let beforeGap = gapTracker.sessionID(for: try event(state: "playing", offset: 0))
        XCTAssertNotEqual(gapTracker.sessionID(for: try event(state: "playing", offset: 601)), beforeGap)
    }

    func testPlayerIDsIsolateVideosOnTheSameFeedURL() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func event(playerID: UUID) throws -> BrowserPlaybackEvent {
            let json: [String: Any] = [
                "schemaVersion": 1, "title": "Feed video", "url": "https://www.instagram.com/reels/",
                "site": "www.instagram.com", "pageSite": "www.instagram.com",
                "duration": 60.0, "position": 1.0, "playbackRate": 1.0, "state": "playing",
                "occurredAtMilliseconds": now.timeIntervalSince1970 * 1000,
                "documentVisible": true, "playerID": playerID.uuidString
            ]
            return try BrowserEventDecoder(now: { now }).decode(JSONSerialization.data(withJSONObject: json))
        }
        var tracker = BrowserSessionTracker()
        XCTAssertNotEqual(
            tracker.sessionID(for: try event(playerID: UUID())),
            tracker.sessionID(for: try event(playerID: UUID()))
        )
    }
}
