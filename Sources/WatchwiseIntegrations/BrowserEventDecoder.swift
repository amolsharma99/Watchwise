import Foundation
import WatchwiseCore

public enum BrowserPlaybackState: String, Codable, Sendable, CaseIterable {
    case playing
    case paused
    case seeking
    case ended
    case heartbeat
}

public struct BrowserPlaybackEvent: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let title: String
    public let url: URL
    public let site: String
    public let pageSite: String?
    public let duration: TimeInterval
    public let position: TimeInterval
    public let playbackRate: Double
    public let state: BrowserPlaybackState
    public let occurredAt: Date
    public let documentVisible: Bool
    public let playerID: UUID?

    public func playbackEvent(sessionID: UUID, id: UUID = UUID()) throws -> PlaybackEvent {
        let coreState: PlaybackState = switch state {
        case .playing, .heartbeat: .playing
        case .paused: .paused
        case .seeking: .seeking
        case .ended: .ended
        }
        return try PlaybackEvent(
            id: id,
            sessionID: sessionID,
            occurredAt: occurredAt,
            canonicalURL: url,
            site: pageSite ?? site,
            title: title,
            durationSeconds: duration,
            positionSeconds: position,
            playbackRate: playbackRate,
            state: coreState
        )
    }
}

public enum BrowserEventDecodingError: Error, Equatable, LocalizedError {
    case malformedJSON
    case unknownFields([String])
    case missingOrInvalid(String)
    case unsafeURL

    public var errorDescription: String? {
        switch self {
        case .malformedJSON: "The browser event was not valid JSON."
        case .unknownFields(let fields): "Unexpected browser fields: \(fields.joined(separator: ", "))."
        case .missingOrInvalid(let field): "The browser field ‘\(field)’ is missing or invalid."
        case .unsafeURL: "Only public HTTPS video URLs are accepted."
        }
    }
}

/// Strictly decodes the small, documented WebExtension bridge schema. Unknown
/// fields are rejected so accidental page data can never silently enter storage.
public struct BrowserEventDecoder: Sendable {
    private let now: @Sendable () -> Date
    private let maximumFutureSkew: TimeInterval

    private static let allowedKeys: Set<String> = [
        "schemaVersion", "title", "url", "site", "duration", "position",
        "playbackRate", "state", "occurredAtMilliseconds", "documentVisible", "playerID", "pageSite"
    ]

    public init(
        now: @escaping @Sendable () -> Date = Date.init,
        maximumFutureSkew: TimeInterval = 5 * 60
    ) {
        self.now = now
        self.maximumFutureSkew = max(0, maximumFutureSkew)
    }

    public func decode(_ data: Data) throws -> BrowserPlaybackEvent {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw BrowserEventDecodingError.malformedJSON
        }
        let unknown = Set(dictionary.keys).subtracting(Self.allowedKeys).sorted()
        guard unknown.isEmpty else { throw BrowserEventDecodingError.unknownFields(unknown) }

        guard dictionary["schemaVersion"] as? Int == 1 else { throw invalid("schemaVersion") }
        guard let rawTitle = dictionary["title"] as? String else { throw invalid("title") }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 512, !title.contains("\u{0000}") else { throw invalid("title") }

        guard let rawURL = dictionary["url"] as? String,
              rawURL.count <= 2_048,
              let url = URL(string: rawURL),
              isSafePublicHTTPS(url) else { throw BrowserEventDecodingError.unsafeURL }

        guard let rawSite = dictionary["site"] as? String else { throw invalid("site") }
        let site = rawSite.lowercased()
        guard site.count <= 253, site == url.host?.lowercased(), isPublicHostname(site) else { throw invalid("site") }
        let pageSite: String?
        if let rawPageSite = dictionary["pageSite"] as? String {
            let normalized = rawPageSite.lowercased()
            guard normalized.count <= 253, isPublicHostname(normalized) else { throw invalid("pageSite") }
            pageSite = normalized
        } else if dictionary["pageSite"] == nil {
            pageSite = nil
        } else {
            throw invalid("pageSite")
        }

        guard let duration = finiteDouble(dictionary["duration"]), duration > 0, duration <= 7 * 24 * 3600 else { throw invalid("duration") }
        guard let position = finiteDouble(dictionary["position"]), position >= 0, position <= duration + 2 else { throw invalid("position") }
        guard let rate = finiteDouble(dictionary["playbackRate"]), (0.25...4).contains(rate) else { throw invalid("playbackRate") }
        guard let rawState = dictionary["state"] as? String,
              let state = BrowserPlaybackState(rawValue: rawState) else { throw invalid("state") }
        guard let timestamp = finiteDouble(dictionary["occurredAtMilliseconds"]), timestamp > 0 else { throw invalid("occurredAtMilliseconds") }
        let occurredAt = Date(timeIntervalSince1970: timestamp / 1_000)
        guard occurredAt <= now().addingTimeInterval(maximumFutureSkew) else { throw invalid("occurredAtMilliseconds") }
        guard let visible = dictionary["documentVisible"] as? Bool, visible else { throw invalid("documentVisible") }
        let playerID: UUID?
        if let rawPlayerID = dictionary["playerID"] as? String {
            guard let decoded = UUID(uuidString: rawPlayerID) else { throw invalid("playerID") }
            playerID = decoded
        } else if dictionary["playerID"] == nil {
            playerID = nil
        } else {
            throw invalid("playerID")
        }

        return BrowserPlaybackEvent(
            schemaVersion: 1,
            title: title,
            url: url,
            site: site,
            pageSite: pageSite,
            duration: duration,
            position: min(position, duration),
            playbackRate: rate,
            state: state,
            occurredAt: occurredAt,
            documentVisible: visible,
            playerID: playerID
        )
    }

    private func invalid(_ field: String) -> BrowserEventDecodingError { .missingOrInvalid(field) }

    private func finiteDouble(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }

    private func isSafePublicHTTPS(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), isPublicHostname(host) else { return false }
        return true
    }

    private func isPublicHostname(_ host: String) -> Bool {
        // Literal IP destinations are unnecessary for supported video sites and
        // make local-network/IPv6 SSRF mistakes easier, so reject IPv6 literals.
        if host.contains(":") { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return false }
        if host == "0.0.0.0" || host == "::1" || host == "[::1]" { return false }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4 {
            if octets[0] == 10 || octets[0] == 127 || octets[0] == 0 { return false }
            if octets[0] == 192 && octets[1] == 168 { return false }
            if octets[0] == 169 && octets[1] == 254 { return false }
            if octets[0] == 172 && (16...31).contains(octets[1]) { return false }
        }
        return host.contains(".")
    }
}
