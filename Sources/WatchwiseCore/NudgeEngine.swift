import Foundation

public enum NudgeSuppressionReason: String, Codable, Sendable {
    case trackingNotConsented
    case notificationsDisabled
    case movieMode
    case snoozed
    case quietHours
    case siteExcluded
    case cooldown
    case hourlyLimit
}

public enum NudgeKind: String, Codable, Sendable {
    case dailyLimit
    case longSession
    case rabbitHole
    case increaseSpeed
    case skipToMainPoint
}

public struct Nudge: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let kind: NudgeKind
    public let title: String
    public let message: String
    public let suggestedTimestamp: Double?
    public let createdAt: Date

    public init(id: UUID = UUID(), kind: NudgeKind, title: String, message: String, suggestedTimestamp: Double? = nil, createdAt: Date) {
        self.id = id
        self.kind = kind
        self.title = title
        self.message = message
        self.suggestedTimestamp = suggestedTimestamp
        self.createdAt = createdAt
    }
}

public struct NudgeContext: Sendable {
    public let now: Date
    public let site: String
    public let dailyActiveSeconds: TimeInterval
    public let continuousSessionSeconds: TimeInterval
    public let distinctVideosInLast20Minutes: Int
    public let playbackRate: Double
    public let informationDensity: Double?
    public let mainPointTimestamp: Double?

    public init(now: Date, site: String, dailyActiveSeconds: TimeInterval, continuousSessionSeconds: TimeInterval, distinctVideosInLast20Minutes: Int, playbackRate: Double, informationDensity: Double? = nil, mainPointTimestamp: Double? = nil) {
        self.now = now
        self.site = site
        self.dailyActiveSeconds = dailyActiveSeconds
        self.continuousSessionSeconds = continuousSessionSeconds
        self.distinctVideosInLast20Minutes = distinctVideosInLast20Minutes
        self.playbackRate = playbackRate
        self.informationDensity = informationDensity
        self.mainPointTimestamp = mainPointTimestamp
    }
}

public enum NudgeMetricsCalculator {
    /// Returns nil unless the most recent event represents active playback and
    /// is fresh enough to avoid nudging after the viewer has already stopped.
    public static func context(
        events: [PlaybackEvent],
        now: Date,
        dailyActiveSeconds: TimeInterval,
        freshness: TimeInterval = 45,
        informationDensity: Double? = nil,
        mainPointTimestamp: Double? = nil
    ) -> NudgeContext? {
        let sorted = events.filter { $0.occurredAt <= now }.sorted { $0.occurredAt < $1.occurredAt }
        guard let latest = sorted.last,
              latest.state == .playing,
              now.timeIntervalSince(latest.occurredAt) >= 0,
              now.timeIntervalSince(latest.occurredAt) <= freshness else { return nil }

        let recentCutoff = now.addingTimeInterval(-20 * 60)
        let distinct = Set(sorted.lazy.filter { $0.occurredAt >= recentCutoff }.map(\.sessionID)).count
        let session = sorted.filter { $0.sessionID == latest.sessionID }
        var active: TimeInterval = min(freshness, max(0, now.timeIntervalSince(latest.occurredAt)))
        for (previous, next) in Array(zip(session, session.dropFirst())).reversed() {
            guard previous.state == .playing else { break }
            let wall = next.occurredAt.timeIntervalSince(previous.occurredAt)
            let media = next.positionSeconds - previous.positionSeconds
            guard wall > 0, wall <= 120, media > 0 else { break }
            active += min(wall, media / max(previous.playbackRate, 0.25))
        }
        return NudgeContext(
            now: now,
            site: latest.site,
            dailyActiveSeconds: dailyActiveSeconds,
            continuousSessionSeconds: active,
            distinctVideosInLast20Minutes: distinct,
            playbackRate: latest.playbackRate,
            informationDensity: informationDensity,
            mainPointTimestamp: mainPointTimestamp
        )
    }
}

public actor NudgeEngine {
    private let cooldown: TimeInterval
    private let hourlyLimit: Int
    private var emitted: [Date] = []

    public init(cooldown: TimeInterval = 10 * 60, hourlyLimit: Int = 3) {
        self.cooldown = max(0, cooldown)
        self.hourlyLimit = max(1, hourlyLimit)
    }

    public func evaluate(_ context: NudgeContext, preferences: UserPreferences, calendar: Calendar = .current) -> Result<Nudge?, NudgeSuppressionReason> {
        if let reason = preferences.suppressionReason(at: context.now, site: context.site, calendar: calendar) {
            return .failure(reason)
        }
        emitted.removeAll { context.now.timeIntervalSince($0) >= 60 * 60 }
        if let latest = emitted.max(), context.now.timeIntervalSince(latest) < cooldown { return .failure(.cooldown) }
        if emitted.count >= hourlyLimit { return .failure(.hourlyLimit) }

        let nudge: Nudge?
        if context.dailyActiveSeconds >= preferences.dailyLimitSeconds {
            nudge = Nudge(kind: .dailyLimit, title: "Daily viewing target reached", message: "You have reached today’s viewing limit. Pause or continue intentionally.", createdAt: context.now)
        } else if context.distinctVideosInLast20Minutes >= 5 {
            nudge = Nudge(kind: .rabbitHole, title: "A quick check-in", message: "You have opened several videos recently. Is the next one still serving your goal?", createdAt: context.now)
        } else if context.continuousSessionSeconds >= preferences.longSessionSeconds {
            nudge = Nudge(kind: .longSession, title: "Still worth your time?", message: "You have been watching continuously. Take a breath or keep going intentionally.", createdAt: context.now)
        } else if let density = context.informationDensity, density < 0.35, let timestamp = context.mainPointTimestamp {
            nudge = Nudge(kind: .skipToMainPoint, title: "The main point may be ahead", message: "The opening appears low-density. You can jump ahead, or keep watching.", suggestedTimestamp: timestamp, createdAt: context.now)
        } else if let density = context.informationDensity, density < 0.5, context.playbackRate <= 1 {
            nudge = Nudge(kind: .increaseSpeed, title: "Try a slightly faster pace?", message: "This section seems slow. Consider 1.25×—only if it still feels comfortable.", createdAt: context.now)
        } else {
            nudge = nil
        }
        if nudge != nil { emitted.append(context.now) }
        return .success(nudge)
    }

    public func resetRateLimit() { emitted.removeAll() }
}

extension NudgeSuppressionReason: Error {}
