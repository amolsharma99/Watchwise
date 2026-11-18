import CSQLite
import Foundation

public enum ViewingStoreError: Error, Sendable {
    case openFailed(String)
    case sqlite(String)
    case encoding
}

private final class SQLiteConnection: @unchecked Sendable {
    let raw: OpaquePointer
    init(_ raw: OpaquePointer) { self.raw = raw }
    deinit { sqlite3_close(raw) }
}

public actor SQLiteViewingStore {
    private let connection: SQLiteConnection
    private let encoder = JSONEncoder()

    public init(path: String) throws {
        var connection: OpaquePointer?
        guard sqlite3_open_v2(path, &connection, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) } ?? "Unknown SQLite error"
            if let connection { sqlite3_close(connection) }
            throw ViewingStoreError.openFailed(message)
        }
        guard let connection else { throw ViewingStoreError.openFailed("SQLite returned no connection") }
        self.connection = SQLiteConnection(connection)
        try Self.execute(connection, sql: "PRAGMA busy_timeout=3000;")
        try Self.execute(connection, sql: "PRAGMA journal_mode=WAL;")
        try Self.execute(connection, sql: "PRAGMA foreign_keys=ON;")
        try Self.execute(connection, sql: """
            CREATE TABLE IF NOT EXISTS playback_events (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                occurred_at REAL NOT NULL,
                canonical_url TEXT NOT NULL,
                site TEXT NOT NULL,
                title TEXT NOT NULL,
                duration REAL NOT NULL,
                position REAL NOT NULL,
                playback_rate REAL NOT NULL,
                state TEXT NOT NULL
            );
            """)
        try Self.execute(connection, sql: "CREATE INDEX IF NOT EXISTS idx_events_time ON playback_events(occurred_at);")
        try Self.execute(connection, sql: "CREATE INDEX IF NOT EXISTS idx_events_session ON playback_events(session_id, occurred_at);")
    }

    public func append(_ event: PlaybackEvent) throws {
        let sql = "INSERT OR IGNORE INTO playback_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection.raw, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw sqliteError() }
        defer { sqlite3_finalize(statement) }
        bind(event.id.uuidString, at: 1, to: statement)
        bind(event.sessionID.uuidString, at: 2, to: statement)
        sqlite3_bind_double(statement, 3, event.occurredAt.timeIntervalSince1970)
        bind(event.canonicalURL.absoluteString, at: 4, to: statement)
        bind(event.site, at: 5, to: statement)
        bind(event.title, at: 6, to: statement)
        sqlite3_bind_double(statement, 7, event.durationSeconds)
        sqlite3_bind_double(statement, 8, event.positionSeconds)
        sqlite3_bind_double(statement, 9, event.playbackRate)
        bind(event.state.rawValue, at: 10, to: statement)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw sqliteError() }
    }

    public func events(in interval: DateInterval) throws -> [PlaybackEvent] {
        let sql = "SELECT id, session_id, occurred_at, canonical_url, site, title, duration, position, playback_rate, state FROM playback_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at ASC;"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection.raw, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw sqliteError() }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, interval.start.timeIntervalSince1970)
        sqlite3_bind_double(statement, 2, interval.end.timeIntervalSince1970)
        var values: [PlaybackEvent] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard
                let id = UUID(uuidString: text(statement, 0)),
                let sessionID = UUID(uuidString: text(statement, 1)),
                let url = URL(string: text(statement, 3)),
                let state = PlaybackState(rawValue: text(statement, 9))
            else { continue }
            let event = try PlaybackEvent(
                id: id,
                sessionID: sessionID,
                occurredAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
                canonicalURL: url,
                site: text(statement, 4),
                title: text(statement, 5),
                durationSeconds: sqlite3_column_double(statement, 6),
                positionSeconds: sqlite3_column_double(statement, 7),
                playbackRate: sqlite3_column_double(statement, 8),
                state: state
            )
            values.append(event)
        }
        return values
    }

    public func insights(in interval: DateInterval) throws -> ViewingInsights {
        InsightEngine.summarize(events: try events(in: interval), interval: interval)
    }

    public func exportJSON() throws -> Data {
        let interval = DateInterval(start: .distantPast, end: .distantFuture)
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(events(in: interval))
    }

    public func deleteAll() throws { try Self.execute(connection.raw, sql: "DELETE FROM playback_events;") }

    private static func execute(_ db: OpaquePointer?, sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "SQLite operation failed"
            sqlite3_free(error)
            throw ViewingStoreError.sqlite(message)
        }
    }

    private func sqliteError() -> ViewingStoreError {
        .sqlite(String(cString: sqlite3_errmsg(connection.raw)))
    }

    private func bind(_ value: String, at index: Int32, to statement: OpaquePointer) {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, index, value, -1, transient)
    }

    private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
        guard let pointer = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: pointer)
    }
}
