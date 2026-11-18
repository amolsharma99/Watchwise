import Foundation

public enum WatchwiseValidationError: Error, Equatable, Sendable {
    case invalidIdentifier
    case invalidURL
    case invalidSite
    case invalidTitle
    case invalidDuration
    case invalidPosition
    case invalidPlaybackRate
    case invalidExcludedSite
}

public enum ExcludedSiteNormalizer {
    public static func normalize(_ input: String) throws -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty, trimmed.utf8.count <= 253 else { throw WatchwiseValidationError.invalidExcludedSite }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate),
              components.scheme == "https",
              components.user == nil,
              components.password == nil,
              let host = components.host?.lowercased(),
              host.contains("."),
              !host.contains(":"),
              host != "localhost",
              !host.hasSuffix(".localhost"),
              !host.hasSuffix(".local") else { throw WatchwiseValidationError.invalidExcludedSite }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4 {
            guard ![0, 10, 127].contains(octets[0]),
                  !(octets[0] == 169 && octets[1] == 254),
                  !(octets[0] == 172 && (16...31).contains(octets[1])),
                  !(octets[0] == 192 && octets[1] == 168) else {
                throw WatchwiseValidationError.invalidExcludedSite
            }
        }
        return host
    }
}

public enum PlaybackState: String, Codable, CaseIterable, Sendable {
    case playing
    case paused
    case seeking
    case ended
}

public struct PlaybackEvent: Codable, Hashable, Identifiable, Sendable {
    public let id: UUID
    public let sessionID: UUID
    public let occurredAt: Date
    public let canonicalURL: URL
    public let site: String
    public let title: String
    public let durationSeconds: Double
    public let positionSeconds: Double
    public let playbackRate: Double
    public let state: PlaybackState

    public init(
        id: UUID = UUID(),
        sessionID: UUID,
        occurredAt: Date,
        canonicalURL: URL,
        site: String,
        title: String,
        durationSeconds: Double,
        positionSeconds: Double,
        playbackRate: Double,
        state: PlaybackState
    ) throws {
        guard canonicalURL.scheme?.lowercased() == "https", canonicalURL.host != nil else {
            throw WatchwiseValidationError.invalidURL
        }
        let cleanSite = site.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanSite.isEmpty, cleanSite.utf8.count <= 255 else { throw WatchwiseValidationError.invalidSite }
        guard !cleanTitle.isEmpty, cleanTitle.utf8.count <= 512 else { throw WatchwiseValidationError.invalidTitle }
        guard durationSeconds.isFinite, durationSeconds > 0, durationSeconds <= 24 * 60 * 60 else {
            throw WatchwiseValidationError.invalidDuration
        }
        guard positionSeconds.isFinite, positionSeconds >= 0, positionSeconds <= durationSeconds + 30 else {
            throw WatchwiseValidationError.invalidPosition
        }
        guard playbackRate.isFinite, (0.25...4).contains(playbackRate) else {
            throw WatchwiseValidationError.invalidPlaybackRate
        }
        self.id = id
        self.sessionID = sessionID
        self.occurredAt = occurredAt
        self.canonicalURL = canonicalURL
        self.site = cleanSite
        self.title = cleanTitle
        self.durationSeconds = durationSeconds
        self.positionSeconds = positionSeconds
        self.playbackRate = playbackRate
        self.state = state
    }
}

public struct QuietHours: Codable, Equatable, Sendable {
    public var startMinute: Int
    public var endMinute: Int

    public init(startMinute: Int = 22 * 60, endMinute: Int = 8 * 60) {
        self.startMinute = min(max(startMinute, 0), 1439)
        self.endMinute = min(max(endMinute, 0), 1439)
    }

    public func contains(_ date: Date, calendar: Calendar) -> Bool {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if startMinute == endMinute { return false }
        if startMinute < endMinute { return (startMinute..<endMinute).contains(minute) }
        return minute >= startMinute || minute < endMinute
    }
}

public struct UserPreferences: Codable, Equatable, Sendable {
    public var trackingConsent: Bool
    public var aiAnalysisConsent: Bool
    public var notificationsEnabled: Bool
    public var movieModeUntil: Date?
    public var snoozedUntil: Date?
    public var quietHoursEnabled: Bool
    public var quietHours: QuietHours
    public var excludedSites: Set<String>
    public var dailyLimitSeconds: TimeInterval
    public var longSessionSeconds: TimeInterval

    public init(
        trackingConsent: Bool = false,
        aiAnalysisConsent: Bool = false,
        notificationsEnabled: Bool = false,
        movieModeUntil: Date? = nil,
        snoozedUntil: Date? = nil,
        quietHoursEnabled: Bool = false,
        quietHours: QuietHours = QuietHours(),
        excludedSites: Set<String> = [],
        dailyLimitSeconds: TimeInterval = 60 * 60,
        longSessionSeconds: TimeInterval = 25 * 60
    ) {
        self.trackingConsent = trackingConsent
        self.aiAnalysisConsent = aiAnalysisConsent
        self.notificationsEnabled = notificationsEnabled
        self.movieModeUntil = movieModeUntil
        self.snoozedUntil = snoozedUntil
        self.quietHoursEnabled = quietHoursEnabled
        self.quietHours = quietHours
        self.excludedSites = Set(excludedSites.compactMap { try? ExcludedSiteNormalizer.normalize($0) })
        self.dailyLimitSeconds = max(5 * 60, dailyLimitSeconds)
        self.longSessionSeconds = max(5 * 60, longSessionSeconds)
    }

    public func suppressionReason(at date: Date, site: String, calendar: Calendar) -> NudgeSuppressionReason? {
        if !trackingConsent { return .trackingNotConsented }
        if !notificationsEnabled { return .notificationsDisabled }
        if isSiteExcluded(site) { return .siteExcluded }
        if let movieModeUntil, movieModeUntil > date { return .movieMode }
        if let snoozedUntil, snoozedUntil > date { return .snoozed }
        if quietHoursEnabled, quietHours.contains(date, calendar: calendar) { return .quietHours }
        return nil
    }

    public func isSiteExcluded(_ site: String) -> Bool {
        let hostname = site.lowercased()
        return excludedSites.contains { hostname == $0 || hostname.hasSuffix(".\($0)") }
    }
}

/// Minimal cross-process consent contract consumed by the native browser host.
/// It intentionally excludes notification state, Movie Mode, history, and all
/// credentials. Movie Mode silences interventions but does not stop accounting.
public struct BridgePrivacySettings: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let trackingConsent: Bool
    public let excludedSites: [String]

    public init(schemaVersion: Int = 1, trackingConsent: Bool, excludedSites: Set<String>) {
        self.schemaVersion = schemaVersion
        self.trackingConsent = trackingConsent
        self.excludedSites = excludedSites.compactMap { try? ExcludedSiteNormalizer.normalize($0) }.sorted()
    }

    public func allowsAccounting(for site: String) -> Bool {
        guard trackingConsent else { return false }
        let hostname = site.lowercased()
        return !excludedSites.contains { hostname == $0 || hostname.hasSuffix(".\($0)") }
    }
}

public enum ValueVerdict: String, Codable, CaseIterable, Sendable {
    case worthWatching
    case skim
    case readSummary
    case probablySkip
    case uncertain
}

public struct TimestampedPoint: Codable, Equatable, Sendable {
    public let seconds: Double
    public let text: String
    public init(seconds: Double, text: String) {
        self.seconds = max(0, seconds)
        self.text = text
    }
}

public struct SkipSegment: Codable, Equatable, Sendable {
    public let startSeconds: Double
    public let endSeconds: Double
    public let reason: String
    public init(startSeconds: Double, endSeconds: Double, reason: String) {
        self.startSeconds = max(0, startSeconds)
        self.endSeconds = max(self.startSeconds, endSeconds)
        self.reason = reason
    }
}

public struct VideoAnalysisRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let url: URL
    public let title: String
    public let submittedAt: Date
    public init(id: UUID = UUID(), url: URL, title: String, submittedAt: Date = Date()) throws {
        guard url.scheme?.lowercased() == "https", url.host != nil else { throw WatchwiseValidationError.invalidURL }
        guard !title.isEmpty, title.utf8.count <= 512 else { throw WatchwiseValidationError.invalidTitle }
        self.id = id
        self.url = url
        self.title = title
        self.submittedAt = submittedAt
    }
}

public struct VideoAnalysisResult: Codable, Equatable, Sendable {
    public let summary: String
    public let keyPoints: [TimestampedPoint]
    public let skipSegments: [SkipSegment]
    public let verdict: ValueVerdict
    public let confidence: Double
    public let evidence: [String]
    public let caveat: String

    public init(summary: String, keyPoints: [TimestampedPoint], skipSegments: [SkipSegment], verdict: ValueVerdict, confidence: Double, evidence: [String], caveat: String = "This is a content-quality assessment, not an external fact-check.") {
        self.summary = summary
        self.keyPoints = keyPoints
        self.skipSegments = skipSegments
        self.verdict = verdict
        self.confidence = min(max(confidence, 0), 1)
        self.evidence = evidence
        self.caveat = caveat
    }
}

public enum AnalysisJobState: Codable, Equatable, Sendable {
    case queued
    case running
    case succeeded(VideoAnalysisResult)
    case failed(message: String)
}

public protocol VideoAnalysisService: Sendable {
    func submit(_ request: VideoAnalysisRequest, consent: Bool) async throws -> UUID
    func status(for jobID: UUID) async throws -> AnalysisJobState
}
