import Foundation

public struct SiteInsight: Codable, Equatable, Sendable {
    public let site: String
    public let activeSeconds: TimeInterval
    public let videosStarted: Int
}

public struct ViewingInsights: Codable, Equatable, Sendable {
    public let interval: DateInterval
    public let activeSeconds: TimeInterval
    public let contentSeconds: TimeInterval
    public let videosStarted: Int
    public let videosCompleted: Int
    public let sites: [SiteInsight]

    public static func empty(interval: DateInterval) -> Self {
        .init(interval: interval, activeSeconds: 0, contentSeconds: 0, videosStarted: 0, videosCompleted: 0, sites: [])
    }
}

public enum InsightEngine {
    public static func summarize(events: [PlaybackEvent], interval: DateInterval) -> ViewingInsights {
        let included = events
            .filter { interval.contains($0.occurredAt) }
            .sorted { lhs, rhs in
                lhs.occurredAt == rhs.occurredAt ? lhs.id.uuidString < rhs.id.uuidString : lhs.occurredAt < rhs.occurredAt
            }
        guard !included.isEmpty else { return .empty(interval: interval) }

        let groups = Dictionary(grouping: included, by: \.sessionID)
        var activeIntervals: [DateInterval] = []
        var content: TimeInterval = 0
        var completed = 0
        var siteSeconds: [String: TimeInterval] = [:]
        var siteSessions: [String: Set<UUID>] = [:]

        for (_, sessionEvents) in groups {
            let sorted = sessionEvents.sorted { $0.occurredAt < $1.occurredAt }
            if sorted.contains(where: { $0.state == .ended }) { completed += 1 }
            if let first = sorted.first { siteSessions[first.site, default: []].insert(first.sessionID) }
            for pair in zip(sorted, sorted.dropFirst()) {
                let previous = pair.0
                let next = pair.1
                guard previous.state == .playing else { continue }
                let wallDelta = next.occurredAt.timeIntervalSince(previous.occurredAt)
                let mediaDelta = next.positionSeconds - previous.positionSeconds
                guard wallDelta > 0, wallDelta <= 120, mediaDelta > 0 else { continue }
                let plausibleMedia = min(mediaDelta, wallDelta * max(previous.playbackRate, 1) * 1.5 + 2)
                let activeDelta = min(wallDelta, plausibleMedia / max(previous.playbackRate, 0.25))
                activeIntervals.append(DateInterval(
                    start: previous.occurredAt,
                    end: previous.occurredAt.addingTimeInterval(activeDelta)
                ))
                content += plausibleMedia
                siteSeconds[previous.site, default: 0] += activeDelta
            }
        }

        let active = unionDuration(of: activeIntervals)
        let sites = siteSeconds.map { site, seconds in
            SiteInsight(site: site, activeSeconds: seconds, videosStarted: siteSessions[site]?.count ?? 0)
        }.sorted { $0.activeSeconds > $1.activeSeconds }
        return ViewingInsights(
            interval: interval,
            activeSeconds: active,
            contentSeconds: content,
            videosStarted: groups.count,
            videosCompleted: completed,
            sites: sites
        )
    }

    /// Multiple visible players can report concurrently (especially across
    /// embedded frames). Daily watch time is wall-clock time, so overlapping
    /// active intervals count once even though content time remains additive.
    private static func unionDuration(of intervals: [DateInterval]) -> TimeInterval {
        let sorted = intervals.sorted { $0.start < $1.start }
        guard let first = sorted.first else { return 0 }
        var total: TimeInterval = 0
        var start = first.start
        var end = first.end
        for interval in sorted.dropFirst() {
            if interval.start <= end {
                end = max(end, interval.end)
            } else {
                total += end.timeIntervalSince(start)
                start = interval.start
                end = interval.end
            }
        }
        return total + end.timeIntervalSince(start)
    }

    public static func dayInterval(containing date: Date, calendar: Calendar) -> DateInterval {
        let start = calendar.startOfDay(for: date)
        return DateInterval(start: start, end: calendar.date(byAdding: .day, value: 1, to: start)!)
    }

    public static func weekInterval(containing date: Date, calendar: Calendar) -> DateInterval {
        calendar.dateInterval(of: .weekOfYear, for: date) ?? dayInterval(containing: date, calendar: calendar)
    }
}
