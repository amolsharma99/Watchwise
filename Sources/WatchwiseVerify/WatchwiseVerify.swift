import Foundation
import WatchwiseCore
import WatchwiseIntegrations

private enum VerificationFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self { case .failed(let message): "Verification failed: \(message)" }
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw VerificationFailure.failed(message) }
}

private struct VerificationKey: APIKeyProviding {
    func apiKey() async throws -> String { "verification-only-key" }
}

private struct VerificationTransport: GeminiTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try require(request.value(forHTTPHeaderField: "x-goog-api-key") == "verification-only-key", "Gemini key header")
        let result = """
        {"summary":"One useful idea.","keyPoints":[{"seconds":42,"text":"Main point"}],"skipSegments":[{"startSeconds":0,"endSeconds":20,"reason":"Introduction"}],"verdict":"skim","confidence":0.8,"evidence":["The introduction repeats the title"],"caveat":"This is not an external fact-check."}
        """
        let data = try JSONSerialization.data(withJSONObject: ["output_text": result])
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@main
struct WatchwiseVerify {
    static func main() async throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let session = UUID()
        let url = URL(string: "https://www.youtube.com/watch?v=verify")!
        let events = try [
            PlaybackEvent(sessionID: session, occurredAt: start, canonicalURL: url, site: "www.youtube.com", title: "Verification", durationSeconds: 600, positionSeconds: 0, playbackRate: 2, state: .playing),
            PlaybackEvent(sessionID: session, occurredAt: start.addingTimeInterval(10), canonicalURL: url, site: "www.youtube.com", title: "Verification", durationSeconds: 600, positionSeconds: 20, playbackRate: 2, state: .paused),
            PlaybackEvent(sessionID: session, occurredAt: start.addingTimeInterval(70), canonicalURL: url, site: "www.youtube.com", title: "Verification", durationSeconds: 600, positionSeconds: 20, playbackRate: 1, state: .playing),
            PlaybackEvent(sessionID: session, occurredAt: start.addingTimeInterval(80), canonicalURL: url, site: "www.youtube.com", title: "Verification", durationSeconds: 600, positionSeconds: 30, playbackRate: 1, state: .ended)
        ]
        let interval = DateInterval(start: start, end: start.addingTimeInterval(100))
        let insights = InsightEngine.summarize(events: events, interval: interval)
        try require(abs(insights.activeSeconds - 20) < 0.001, "paused time exclusion")
        try require(abs(insights.contentSeconds - 30) < 0.001, "content-time calculation")

        let overlapping = try [
            PlaybackEvent(sessionID: UUID(), occurredAt: start, canonicalURL: url, site: "frame-one.example", title: "One", durationSeconds: 60, positionSeconds: 0, playbackRate: 1, state: .playing),
            PlaybackEvent(sessionID: UUID(), occurredAt: start, canonicalURL: url, site: "frame-two.example", title: "Two", durationSeconds: 60, positionSeconds: 0, playbackRate: 1, state: .playing)
        ]
        let overlappingEnds = try overlapping.map { event in
            try PlaybackEvent(sessionID: event.sessionID, occurredAt: start.addingTimeInterval(10), canonicalURL: url, site: event.site, title: event.title, durationSeconds: 60, positionSeconds: 10, playbackRate: 1, state: .paused)
        }
        let concurrentInsights = InsightEngine.summarize(events: overlapping + overlappingEnds, interval: interval)
        try require(abs(concurrentInsights.activeSeconds - 10) < 0.001, "overlapping player wall-clock de-duplication")
        try require(abs(concurrentInsights.contentSeconds - 20) < 0.001, "overlapping player content accounting")

        let preferences = UserPreferences(trackingConsent: true, notificationsEnabled: false)
        let context = NudgeContext(now: start, site: "www.youtube.com", dailyActiveSeconds: 5_000, continuousSessionSeconds: 2_000, distinctVideosInLast20Minutes: 5, playbackRate: 1)
        let suppressed = await NudgeEngine(cooldown: 0).evaluate(context, preferences: preferences)
        try require(suppressed == .failure(.notificationsDisabled), "notification suppression")

        let store = try SQLiteViewingStore(path: ":memory:")
        try await store.append(events[0])
        let storedEvents = try await store.events(in: interval)
        try require(storedEvents.count == 1, "SQLite round trip")
        try await store.deleteAll()
        let eventsAfterDeletion = try await store.events(in: interval)
        try require(eventsAfterDeletion.isEmpty, "SQLite deletion")

        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let payload: [String: Any] = [
            "schemaVersion": 1, "title": "Verification", "url": url.absoluteString,
            "site": "www.youtube.com", "duration": 600.0, "position": 42.0,
            "playbackRate": 1.0, "state": "playing",
            "occurredAtMilliseconds": now.timeIntervalSince1970 * 1_000, "documentVisible": true
        ]
        let decoded = try BrowserEventDecoder(now: { now }).decode(JSONSerialization.data(withJSONObject: payload))
        try require(decoded.site == "www.youtube.com", "browser allow-list decoder")
        var feedPayload = payload
        feedPayload["url"] = "https://www.instagram.com/reels/"
        feedPayload["site"] = "www.instagram.com"
        feedPayload["pageSite"] = "social.example.com"
        feedPayload["playerID"] = UUID().uuidString
        let firstFeed = try BrowserEventDecoder(now: { now }).decode(JSONSerialization.data(withJSONObject: feedPayload))
        feedPayload["playerID"] = UUID().uuidString
        let secondFeed = try BrowserEventDecoder(now: { now }).decode(JSONSerialization.data(withJSONObject: feedPayload))
        var sessions = BrowserSessionTracker()
        try require(sessions.sessionID(for: firstFeed) != sessions.sessionID(for: secondFeed), "separate videos on one feed URL")
        let attributedEvent = try firstFeed.playbackEvent(sessionID: UUID())
        try require(attributedEvent.site == "social.example.com", "top-level site attribution")
        feedPayload["playerID"] = "invalid"
        do {
            _ = try BrowserEventDecoder(now: { now }).decode(JSONSerialization.data(withJSONObject: feedPayload))
            throw VerificationFailure.failed("invalid player ID accepted")
        } catch BrowserEventDecodingError.missingOrInvalid("playerID") {}
        let framed = try NativeMessageFramer.frame(Data("{}".utf8))
        let deframed = try NativeMessageFramer.decodeSingleFrame(framed)
        try require(deframed == Data("{}".utf8), "native message framing")

        let analysis = GeminiAnalysisService(keyProvider: VerificationKey(), transport: VerificationTransport())
        let analysisRequest = try VideoAnalysisRequest(url: url, title: "Verification")
        let job = try await analysis.submit(analysisRequest, consent: true)
        let state = try await analysis.waitForCompletion(jobID: job)
        guard case .succeeded(let result) = state else { throw VerificationFailure.failed("async Gemini job") }
        try require(result.verdict == .skim, "structured Gemini verdict")
        try require(result.caveat.localizedCaseInsensitiveContains("not an external fact-check"), "AI caveat")

        print("Watchwise core, SQLite, nudge, browser contract, framing, and async analysis: PASS")
    }
}
