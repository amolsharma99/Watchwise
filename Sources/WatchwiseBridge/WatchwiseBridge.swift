import Foundation
import WatchwiseCore
import WatchwiseIntegrations

@main
struct WatchwiseBridge {
    static func main() async {
        do {
            let databasePath = try databasePath()
            let settingsPath = URL(fileURLWithPath: databasePath).deletingLastPathComponent()
                .appendingPathComponent("bridge-settings.json", isDirectory: false)
            let store = try SQLiteViewingStore(path: databasePath)
            var sessions = BrowserSessionTracker()
            let decoder = BrowserEventDecoder()
            while let payload = try NativeMessageFramer.readFrame(from: .standardInput) {
                do {
                    let browserEvent = try decoder.decode(payload)
                    let privacy = try loadPrivacySettings(from: settingsPath)
                    guard privacy.allowsAccounting(for: browserEvent.site),
                          browserEvent.pageSite.map(privacy.allowsAccounting(for:)) ?? true else {
                        try writeResponse(ok: false, error: "privacy_blocked")
                        continue
                    }
                    let sessionID = sessions.sessionID(for: browserEvent)
                    try await store.append(try browserEvent.playbackEvent(sessionID: sessionID))
                    try writeResponse(ok: true, error: nil)
                } catch {
                    // Never echo or log payload details, titles, URLs, or provider errors.
                    try writeResponse(ok: false, error: "invalid_or_unavailable")
                }
            }
        } catch {
            // Oversized/truncated framing cannot be safely resynchronised. Return
            // one generic response when possible and terminate without logging.
            try? writeResponse(ok: false, error: "bridge_stopped")
        }
    }

    private static func loadPrivacySettings(from url: URL) throws -> BridgePrivacySettings {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count <= 64 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
        let decoded = try JSONDecoder().decode(BridgePrivacySettings.self, from: data)
        let canonical = BridgePrivacySettings(
            trackingConsent: decoded.trackingConsent,
            excludedSites: Set(decoded.excludedSites)
        )
        guard decoded.schemaVersion == 1, decoded == canonical else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return decoded
    }

    private static func databasePath() throws -> String {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.count == 2, arguments[0] == "--database-path" {
            let explicit = URL(fileURLWithPath: arguments[1], isDirectory: false)
            guard explicit.path.hasPrefix("/") else { throw CocoaError(.fileNoSuchFile) }
            return explicit.path
        }
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("Watchwise", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("history.sqlite3", isDirectory: false).path
    }

    private static func writeResponse(ok: Bool, error: String?) throws {
        var object: [String: Any] = ["ok": ok]
        if let error { object["error"] = error }
        let data = try JSONSerialization.data(withJSONObject: object)
        try NativeMessageFramer.writeFrame(data, to: .standardOutput)
    }
}
