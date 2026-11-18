import Foundation

public enum NativeMessagingError: Error, Equatable, Sendable {
    case truncatedHeader
    case truncatedPayload
    case oversizedMessage(Int)
    case emptyMessage
}

/// Chromium native messaging uses a four-byte little-endian payload length
/// followed by one UTF-8 JSON object. Watchwise caps messages well below the
/// browser maximum because its allow-listed telemetry events are tiny.
public enum NativeMessageFramer {
    public static let defaultMaximumSize = 64 * 1024

    public static func frame(_ payload: Data, maximumSize: Int = defaultMaximumSize) throws -> Data {
        guard !payload.isEmpty else { throw NativeMessagingError.emptyMessage }
        guard payload.count <= maximumSize else { throw NativeMessagingError.oversizedMessage(payload.count) }
        var length = UInt32(payload.count).littleEndian
        var result = withUnsafeBytes(of: &length) { Data($0) }
        result.append(payload)
        return result
    }

    public static func decodeSingleFrame(_ data: Data, maximumSize: Int = defaultMaximumSize) throws -> Data {
        guard data.count >= 4 else { throw NativeMessagingError.truncatedHeader }
        let bytes = [UInt8](data.prefix(4))
        let length = Int(UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24)
        guard length > 0 else { throw NativeMessagingError.emptyMessage }
        guard length <= maximumSize else { throw NativeMessagingError.oversizedMessage(length) }
        guard data.count == 4 + length else { throw NativeMessagingError.truncatedPayload }
        return data.subdata(in: 4..<(4 + length))
    }

    public static func readFrame(from handle: FileHandle, maximumSize: Int = defaultMaximumSize) throws -> Data? {
        guard let header = try readExactly(4, from: handle, allowCleanEOF: true) else { return nil }
        let bytes = [UInt8](header)
        let length = Int(UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24)
        guard length > 0 else { throw NativeMessagingError.emptyMessage }
        guard length <= maximumSize else { throw NativeMessagingError.oversizedMessage(length) }
        guard let payload = try readExactly(length, from: handle, allowCleanEOF: false) else {
            throw NativeMessagingError.truncatedPayload
        }
        return payload
    }

    public static func writeFrame(_ payload: Data, to handle: FileHandle, maximumSize: Int = defaultMaximumSize) throws {
        try handle.write(contentsOf: frame(payload, maximumSize: maximumSize))
    }

    private static func readExactly(_ count: Int, from handle: FileHandle, allowCleanEOF: Bool) throws -> Data? {
        var result = Data()
        while result.count < count {
            let chunk = try handle.read(upToCount: count - result.count) ?? Data()
            if chunk.isEmpty {
                if result.isEmpty, allowCleanEOF { return nil }
                throw result.count < 4 && count == 4 ? NativeMessagingError.truncatedHeader : NativeMessagingError.truncatedPayload
            }
            result.append(chunk)
        }
        return result
    }
}

public struct BrowserSessionTracker: Sendable {
    private struct Active: Sendable {
        var id: UUID
        var lastSeen: Date
        var ended: Bool
    }
    private var activeByURL: [String: Active] = [:]
    public let inactivityGap: TimeInterval

    public init(inactivityGap: TimeInterval = 10 * 60) {
        self.inactivityGap = max(60, inactivityGap)
    }

    public mutating func sessionID(for event: BrowserPlaybackEvent) -> UUID {
        let key = event.url.absoluteString + "#" + (event.playerID?.uuidString ?? "legacy")
        activeByURL = activeByURL.filter { event.occurredAt.timeIntervalSince($0.value.lastSeen) < 24 * 60 * 60 }
        let prior = activeByURL[key]
        let needsNew = prior == nil || prior!.ended || event.occurredAt.timeIntervalSince(prior!.lastSeen) > inactivityGap
        let id = needsNew ? UUID() : prior!.id
        activeByURL[key] = Active(id: id, lastSeen: max(event.occurredAt, prior?.lastSeen ?? event.occurredAt), ended: event.state == .ended)
        return id
    }
}
