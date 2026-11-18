import Foundation
import XCTest
@testable import WatchwiseCore

final class CoreTests: XCTestCase {
    private let videoURL = URL(string: "https://www.youtube.com/watch?v=test")!

    private func event(session: UUID, at date: Date, position: Double, state: PlaybackState, site: String = "youtube.com", rate: Double = 1) throws -> PlaybackEvent {
        try PlaybackEvent(sessionID: session, occurredAt: date, canonicalURL: videoURL, site: site, title: "A useful video", durationSeconds: 600, positionSeconds: position, playbackRate: rate, state: state)
    }

    func testPlaybackValidationRejectsPrivateAndInvalidValues() throws {
        XCTAssertThrowsError(try PlaybackEvent(sessionID: UUID(), occurredAt: Date(), canonicalURL: URL(string: "file:///private/movie.mp4")!, site: "local", title: "Movie", durationSeconds: 100, positionSeconds: 0, playbackRate: 1, state: .playing)) {
            XCTAssertEqual($0 as? WatchwiseValidationError, .invalidURL)
        }
        XCTAssertThrowsError(try PlaybackEvent(sessionID: UUID(), occurredAt: Date(), canonicalURL: videoURL, site: "youtube.com", title: "Video", durationSeconds: 100, positionSeconds: 0, playbackRate: 10, state: .playing)) {
            XCTAssertEqual($0 as? WatchwiseValidationError, .invalidPlaybackRate)
        }
    }

    func testInsightsExcludePausedTimeAndTrackContentAtSpeed() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let session = UUID()
        let events = try [
            event(session: session, at: start, position: 0, state: .playing, rate: 2),
            event(session: session, at: start.addingTimeInterval(10), position: 20, state: .paused, rate: 2),
            event(session: session, at: start.addingTimeInterval(70), position: 20, state: .playing, rate: 1),
            event(session: session, at: start.addingTimeInterval(80), position: 30, state: .ended, rate: 1)
        ]
        let insights = InsightEngine.summarize(events: events, interval: DateInterval(start: start, end: start.addingTimeInterval(100)))
        XCTAssertEqual(insights.activeSeconds, 20, accuracy: 0.001)
        XCTAssertEqual(insights.contentSeconds, 30, accuracy: 0.001)
        XCTAssertEqual(insights.videosStarted, 1)
        XCTAssertEqual(insights.videosCompleted, 1)
    }

    func testOverlappingPlayersCountWallClockTimeOnce() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let first = UUID()
        let second = UUID()
        let values = try [
            event(session: first, at: start, position: 0, state: .playing),
            event(session: second, at: start, position: 0, state: .playing),
            event(session: first, at: start.addingTimeInterval(10), position: 10, state: .paused),
            event(session: second, at: start.addingTimeInterval(10), position: 10, state: .paused)
        ]
        let insights = InsightEngine.summarize(
            events: values,
            interval: DateInterval(start: start, end: start.addingTimeInterval(20))
        )
        XCTAssertEqual(insights.activeSeconds, 10, accuracy: 0.001)
        XCTAssertEqual(insights.contentSeconds, 20, accuracy: 0.001)
    }

    func testDayBoundariesRespectChosenTimeZone() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 5 * 3600 + 30 * 60)!
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let interval = InsightEngine.dayInterval(containing: date, calendar: calendar)
        XCTAssertTrue(interval.contains(date))
        XCTAssertEqual(interval.duration, 24 * 60 * 60)
        XCTAssertEqual(calendar.component(.hour, from: interval.start), 0)
    }

    func testExcludedSiteNormalizationRejectsLocalTargets() throws {
        XCTAssertEqual(try ExcludedSiteNormalizer.normalize(" HTTPS://YouTube.com/watch?v=x "), "youtube.com")
        XCTAssertThrowsError(try ExcludedSiteNormalizer.normalize("localhost"))
        XCTAssertThrowsError(try ExcludedSiteNormalizer.normalize("192.168.1.2"))
        XCTAssertThrowsError(try ExcludedSiteNormalizer.normalize("https://user:secret@example.com"))
    }

    func testBridgePrivacySettingsGateAccountingWithoutMovieOrSecrets() throws {
        let settings = BridgePrivacySettings(trackingConsent: true, excludedSites: ["youtube.com"])
        XCTAssertFalse(settings.allowsAccounting(for: "www.youtube.com"))
        XCTAssertTrue(settings.allowsAccounting(for: "vimeo.com"))
        let encoded = try JSONEncoder().encode(settings)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["schemaVersion", "trackingConsent", "excludedSites"])

        let disabled = BridgePrivacySettings(trackingConsent: false, excludedSites: [])
        XCTAssertFalse(disabled.allowsAccounting(for: "vimeo.com"))
    }

    func testNudgeMetricsRequireFreshActivePlaybackAndCountRecentVideos() throws {
        let now = Date(timeIntervalSince1970: 1_700_001_000)
        let activeSession = UUID()
        let otherSession = UUID()
        let values = try [
            event(session: otherSession, at: now.addingTimeInterval(-15 * 60), position: 0, state: .playing),
            event(session: otherSession, at: now.addingTimeInterval(-14 * 60), position: 60, state: .ended),
            event(session: activeSession, at: now.addingTimeInterval(-30), position: 10, state: .playing),
            event(session: activeSession, at: now.addingTimeInterval(-15), position: 25, state: .playing)
        ]
        let context = try XCTUnwrap(NudgeMetricsCalculator.context(events: values, now: now, dailyActiveSeconds: 120))
        XCTAssertEqual(context.distinctVideosInLast20Minutes, 2)
        XCTAssertEqual(context.continuousSessionSeconds, 30, accuracy: 0.001)

        let paused = try values + [event(session: activeSession, at: now.addingTimeInterval(-2), position: 30, state: .paused)]
        XCTAssertNil(NudgeMetricsCalculator.context(events: paused, now: now, dailyActiveSeconds: 120))

        let stale = try [event(session: activeSession, at: now.addingTimeInterval(-60), position: 10, state: .playing)]
        XCTAssertNil(NudgeMetricsCalculator.context(events: stale, now: now, dailyActiveSeconds: 120))
    }

    func testContinuousMetricResetsAfterPause() throws {
        let now = Date(timeIntervalSince1970: 1_700_001_000)
        let session = UUID()
        let values = try [
            event(session: session, at: now.addingTimeInterval(-300), position: 0, state: .playing),
            event(session: session, at: now.addingTimeInterval(-240), position: 60, state: .paused),
            event(session: session, at: now.addingTimeInterval(-30), position: 60, state: .playing),
            event(session: session, at: now.addingTimeInterval(-15), position: 75, state: .playing)
        ]
        let context = try XCTUnwrap(NudgeMetricsCalculator.context(events: values, now: now, dailyActiveSeconds: 120))
        XCTAssertEqual(context.continuousSessionSeconds, 30, accuracy: 0.001)
    }

    func testNotificationsOffMovieModeSnoozeAndExclusionsSuppressNudges() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let context = NudgeContext(now: now, site: "youtube.com", dailyActiveSeconds: 10_000, continuousSessionSeconds: 10_000, distinctVideosInLast20Minutes: 10, playbackRate: 1)
        let off = UserPreferences(trackingConsent: true, notificationsEnabled: false)
        let offResult = await NudgeEngine(cooldown: 0).evaluate(context, preferences: off)
        XCTAssertEqual(offResult, .failure(.notificationsDisabled))
        let movie = UserPreferences(trackingConsent: true, notificationsEnabled: true, movieModeUntil: now.addingTimeInterval(60))
        let movieResult = await NudgeEngine(cooldown: 0).evaluate(context, preferences: movie)
        XCTAssertEqual(movieResult, .failure(.movieMode))
        let snoozed = UserPreferences(trackingConsent: true, notificationsEnabled: true, snoozedUntil: now.addingTimeInterval(60))
        let snoozedResult = await NudgeEngine(cooldown: 0).evaluate(context, preferences: snoozed)
        XCTAssertEqual(snoozedResult, .failure(.snoozed))
        let excluded = UserPreferences(trackingConsent: true, notificationsEnabled: true, excludedSites: ["youtube.com"])
        let excludedResult = await NudgeEngine(cooldown: 0).evaluate(context, preferences: excluded)
        XCTAssertEqual(excludedResult, .failure(.siteExcluded))
        let subdomainContext = NudgeContext(now: now, site: "www.youtube.com", dailyActiveSeconds: 10_000, continuousSessionSeconds: 10_000, distinctVideosInLast20Minutes: 10, playbackRate: 1)
        let subdomainResult = await NudgeEngine(cooldown: 0).evaluate(subdomainContext, preferences: excluded)
        XCTAssertEqual(subdomainResult, .failure(.siteExcluded))
    }

    func testNudgePriorityAndRateLimitsAreFriendly() async throws {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let preferences = UserPreferences(trackingConsent: true, notificationsEnabled: true, dailyLimitSeconds: 3_600, longSessionSeconds: 1_500)
        let engine = NudgeEngine(cooldown: 600, hourlyLimit: 3)
        let first = NudgeContext(now: base, site: "youtube.com", dailyActiveSeconds: 3_600, continuousSessionSeconds: 1_500, distinctVideosInLast20Minutes: 6, playbackRate: 1)
        let firstResult = try await engine.evaluate(first, preferences: preferences).get()
        XCTAssertEqual(firstResult?.kind, .dailyLimit)
        let soon = NudgeContext(now: base.addingTimeInterval(60), site: "youtube.com", dailyActiveSeconds: 3_600, continuousSessionSeconds: 1_500, distinctVideosInLast20Minutes: 6, playbackRate: 1)
        let soonResult = await engine.evaluate(soon, preferences: preferences)
        XCTAssertEqual(soonResult, .failure(.cooldown))
    }

    func testLowDensityNudgeUsesCautiousLanguageAndTimestamp() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let context = NudgeContext(now: now, site: "youtube.com", dailyActiveSeconds: 10, continuousSessionSeconds: 10, distinctVideosInLast20Minutes: 1, playbackRate: 1, informationDensity: 0.2, mainPointTimestamp: 252)
        let result = try await NudgeEngine(cooldown: 0).evaluate(context, preferences: UserPreferences(trackingConsent: true, notificationsEnabled: true)).get()
        XCTAssertEqual(result?.kind, .skipToMainPoint)
        XCTAssertEqual(result?.suggestedTimestamp, 252)
        XCTAssertTrue(result?.message.contains("appears") == true)
    }

    func testSQLiteRoundTripUsesBoundValuesAndSupportsDeletion() async throws {
        let store = try SQLiteViewingStore(path: ":memory:")
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let title = "Robert'); DROP TABLE playback_events;--"
        let value = try PlaybackEvent(sessionID: UUID(), occurredAt: start, canonicalURL: videoURL, site: "youtube.com", title: title, durationSeconds: 100, positionSeconds: 0, playbackRate: 1, state: .playing)
        try await store.append(value)
        let interval = DateInterval(start: start.addingTimeInterval(-1), end: start.addingTimeInterval(1))
        let stored = try await store.events(in: interval)
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.title, title)
        let exported = try await store.exportJSON()
        XCTAssertTrue(String(decoding: exported, as: UTF8.self).contains(title))
        try await store.deleteAll()
        let afterDelete = try await store.events(in: interval)
        XCTAssertTrue(afterDelete.isEmpty)
    }

    func testAnalysisResultAlwaysCarriesFactCheckCaveat() {
        let result = VideoAnalysisResult(summary: "One idea repeated with few examples.", keyPoints: [.init(seconds: 12, text: "Main idea")], skipSegments: [.init(startSeconds: 0, endSeconds: 10, reason: "Intro")], verdict: .skim, confidence: 2, evidence: ["The same claim is repeated."])
        XCTAssertEqual(result.confidence, 1)
        XCTAssertTrue(result.caveat.lowercased().contains("not an external fact-check"))
    }
}
