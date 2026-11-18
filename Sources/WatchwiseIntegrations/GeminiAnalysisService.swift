import Foundation
import Security
import WatchwiseCore

public enum AnalysisServiceError: Error, Equatable, LocalizedError, Sendable {
    case aiConsentRequired
    case unsafeOrPrivateURL
    case siteExcluded
    case movieModeActive
    case missingAPIKey
    case keychainFailure(Int32)
    case invalidResponse
    case serviceFailure(Int)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .aiConsentRequired: "AI analysis is off. Enable it before sending a video."
        case .unsafeOrPrivateURL: "Only public HTTPS video URLs can be analysed."
        case .siteExcluded: "This site is excluded from Watchwise analysis."
        case .movieModeActive: "Analysis is paused while Movie Mode is active."
        case .missingAPIKey: "Add your Gemini API key in Watchwise settings."
        case .keychainFailure: "The API key could not be read securely from Keychain."
        case .invalidResponse: "Gemini returned a response Watchwise could not safely interpret."
        case .serviceFailure(let status): "Gemini returned HTTP \(status)."
        case .cancelled: "Analysis was cancelled."
        }
    }
}

public protocol APIKeyProviding: Sendable {
    func apiKey() async throws -> String
}

public struct KeychainAPIKeyStore: APIKeyProviding, Sendable {
    public let service: String
    public let account: String

    public init(service: String = "com.watchwise.gemini", account: String = "api-key") {
        self.service = service
        self.account = account
    }

    public func apiKey() async throws -> String {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw AnalysisServiceError.missingAPIKey }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AnalysisServiceError.keychainFailure(status)
        }
        return value
    }

    public func save(_ key: String) throws {
        let clean = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 512 else { throw AnalysisServiceError.missingAPIKey }
        var attributes = baseQuery
        attributes[kSecValueData as String] = Data(clean.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updates: [String: Any] = [kSecValueData as String: Data(clean.utf8)]
            let updateStatus = SecItemUpdate(baseQuery as CFDictionary, updates as CFDictionary)
            guard updateStatus == errSecSuccess else { throw AnalysisServiceError.keychainFailure(updateStatus) }
        } else if status != errSecSuccess {
            throw AnalysisServiceError.keychainFailure(status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AnalysisServiceError.keychainFailure(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

public protocol GeminiTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionGeminiTransport: GeminiTransport, Sendable {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AnalysisServiceError.invalidResponse }
        return (data, http)
    }
}

public struct GeminiConfiguration: Sendable {
    public var model: String
    public var endpoint: URL

    public init(model: String = "gemini-2.5-flash", endpoint: URL = URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!) {
        self.model = model
        self.endpoint = endpoint
    }
}

private struct GeminiWireRequest: Encodable {
    struct Input: Encodable {
        let type: String
        let text: String?
        let uri: String?
    }
    let model: String
    let input: [Input]
    let background: Bool
}

private struct ResultDTO: Decodable {
    struct Point: Decodable { let seconds: Double; let text: String }
    struct Segment: Decodable { let startSeconds: Double; let endSeconds: Double; let reason: String }
    let summary: String
    let keyPoints: [Point]
    let skipSegments: [Segment]
    let verdict: String
    let confidence: Double
    let evidence: [String]
    let caveat: String?
}

/// Consent-gated asynchronous analysis. Job state is local and intentionally
/// contains no API key, request body, transcript, or raw service response.
public actor GeminiAnalysisService: VideoAnalysisService {
    private let keyProvider: any APIKeyProviding
    private let transport: any GeminiTransport
    private let configuration: GeminiConfiguration
    private var jobs: [UUID: AnalysisJobState] = [:]
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var excludedSites: Set<String> = []
    private var movieModeUntil: Date?

    public init(
        keyProvider: any APIKeyProviding = KeychainAPIKeyStore(),
        transport: any GeminiTransport = URLSessionGeminiTransport(),
        configuration: GeminiConfiguration = GeminiConfiguration()
    ) {
        self.keyProvider = keyProvider
        self.transport = transport
        self.configuration = configuration
    }

    public func updatePrivacyContext(excludedSites: Set<String>, movieModeUntil: Date?) {
        self.excludedSites = Set(excludedSites.map { $0.lowercased() })
        self.movieModeUntil = movieModeUntil
    }

    public func submit(_ request: VideoAnalysisRequest, consent: Bool) async throws -> UUID {
        guard consent else { throw AnalysisServiceError.aiConsentRequired }
        guard Self.isSafePublicHTTPS(request.url) else { throw AnalysisServiceError.unsafeOrPrivateURL }
        let host = request.url.host?.lowercased() ?? ""
        guard !excludedSites.contains(host) else { throw AnalysisServiceError.siteExcluded }
        guard movieModeUntil.map({ $0 <= Date() }) ?? true else { throw AnalysisServiceError.movieModeActive }

        let jobID = UUID()
        jobs[jobID] = .queued
        tasks[jobID] = Task { [weak self] in
            await self?.run(jobID: jobID, request: request)
        }
        return jobID
    }

    public func status(for jobID: UUID) async throws -> AnalysisJobState {
        guard let state = jobs[jobID] else { throw AnalysisServiceError.invalidResponse }
        return state
    }

    public func cancel(jobID: UUID) {
        tasks[jobID]?.cancel()
        tasks[jobID] = nil
        jobs[jobID] = .failed(message: AnalysisServiceError.cancelled.localizedDescription)
    }

    public func waitForCompletion(jobID: UUID) async throws -> AnalysisJobState {
        while true {
            let state = try await status(for: jobID)
            switch state {
            case .queued, .running:
                try await Task.sleep(for: .milliseconds(50))
            case .succeeded, .failed:
                return state
            }
        }
    }

    /// A UI can consume this stream and schedule one local notification when it
    /// receives a terminal state. It yields only state changes and then closes.
    public func updates(for jobID: UUID) -> AsyncStream<AnalysisJobState> {
        AsyncStream { continuation in
            let monitor = Task {
                var previous: AnalysisJobState?
                while !Task.isCancelled {
                    do {
                        let current = try await self.status(for: jobID)
                        if current != previous {
                            continuation.yield(current)
                            previous = current
                        }
                        switch current {
                        case .succeeded, .failed:
                            continuation.finish()
                            return
                        case .queued, .running:
                            try await Task.sleep(for: .milliseconds(100))
                        }
                    } catch {
                        continuation.finish()
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in monitor.cancel() }
        }
    }

    private func run(jobID: UUID, request: VideoAnalysisRequest) async {
        jobs[jobID] = .running
        do {
            try Task.checkCancellation()
            let apiKey = try await keyProvider.apiKey()
            let urlRequest = try makeRequest(for: request, apiKey: apiKey)
            let (submissionData, response) = try await transport.data(for: urlRequest)
            try Task.checkCancellation()
            guard (200..<300).contains(response.statusCode) else {
                throw AnalysisServiceError.serviceFailure(response.statusCode)
            }
            let completedData = try await awaitBackgroundResult(
                submissionData: submissionData,
                apiKey: apiKey
            )
            jobs[jobID] = .succeeded(try parseResponse(completedData))
        } catch is CancellationError {
            jobs[jobID] = .failed(message: AnalysisServiceError.cancelled.localizedDescription)
        } catch let error as AnalysisServiceError {
            jobs[jobID] = .failed(message: error.localizedDescription)
        } catch {
            jobs[jobID] = .failed(message: "Analysis failed without exposing private request details.")
        }
        tasks[jobID] = nil
    }

    private func makeRequest(for analysis: VideoAnalysisRequest, apiKey: String) throws -> URLRequest {
        let prompt = """
        Return JSON only. Summarise this video and assess information value without claiming to have externally fact-checked it. Schema: {summary:string,keyPoints:[{seconds:number,text:string}],skipSegments:[{startSeconds:number,endSeconds:number,reason:string}],verdict:one of worthWatching|skim|readSummary|probablySkip|uncertain,confidence:number 0...1,evidence:[string],caveat:string}. Identify title/content mismatch or unsupported claims only as cautious signals. Keep the summary under 1200 characters, at most 8 key points, 6 skip segments, and 8 evidence items.
        """
        let body = GeminiWireRequest(
            model: configuration.model,
            input: [
                .init(type: "video", text: nil, uri: analysis.url.absoluteString),
                .init(type: "text", text: prompt, uri: nil)
            ],
            background: true
        )
        var request = URLRequest(url: configuration.endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.timeoutInterval = 60
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private func awaitBackgroundResult(submissionData: Data, apiKey: String) async throws -> Data {
        guard !Self.containsModelText(submissionData) else { return submissionData }
        guard let interactionID = Self.interactionID(submissionData) else {
            throw AnalysisServiceError.invalidResponse
        }
        let pollURL = configuration.endpoint.appendingPathComponent(interactionID)
        // Poll for up to 30 minutes. The task remains cancellable and does not
        // keep the UI or submit call blocked.
        for _ in 0..<360 {
            try Task.checkCancellation()
            try await Task.sleep(for: .seconds(5))
            var poll = URLRequest(url: pollURL)
            poll.httpMethod = "GET"
            poll.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
            poll.timeoutInterval = 30
            let (data, response) = try await transport.data(for: poll)
            guard (200..<300).contains(response.statusCode) else {
                throw AnalysisServiceError.serviceFailure(response.statusCode)
            }
            if Self.containsModelText(data) { return data }
            if Self.interactionFailed(data) { throw AnalysisServiceError.invalidResponse }
        }
        throw AnalysisServiceError.invalidResponse
    }

    private func parseResponse(_ data: Data) throws -> VideoAnalysisResult {
        guard let json = try? JSONSerialization.jsonObject(with: data),
              let text = Self.findModelText(in: json),
              let resultData = Self.extractJSONObject(from: text).data(using: .utf8),
              let dto = try? JSONDecoder().decode(ResultDTO.self, from: resultData),
              !dto.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              dto.summary.count <= 1_200,
              dto.confidence.isFinite else { throw AnalysisServiceError.invalidResponse }

        let verdict = ValueVerdict(rawValue: dto.verdict) ?? .uncertain
        let points = dto.keyPoints.prefix(8).compactMap { point -> TimestampedPoint? in
            guard point.seconds.isFinite, point.seconds >= 0, !point.text.isEmpty, point.text.count <= 500 else { return nil }
            return TimestampedPoint(seconds: point.seconds, text: point.text)
        }
        let segments = dto.skipSegments.prefix(6).compactMap { segment -> SkipSegment? in
            guard segment.startSeconds.isFinite, segment.endSeconds.isFinite,
                  segment.startSeconds >= 0, segment.endSeconds >= segment.startSeconds,
                  !segment.reason.isEmpty, segment.reason.count <= 500 else { return nil }
            return SkipSegment(startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, reason: segment.reason)
        }
        let evidence = dto.evidence.prefix(8).filter { !$0.isEmpty }.map { String($0.prefix(500)) }
        let requiredCaveat = "This is a content-quality assessment, not an external fact-check."
        let caveat = dto.caveat?.localizedCaseInsensitiveContains("not an external fact-check") == true
            ? String(dto.caveat!.prefix(500))
            : requiredCaveat
        return VideoAnalysisResult(
            summary: dto.summary,
            keyPoints: Array(points),
            skipSegments: Array(segments),
            verdict: verdict,
            confidence: dto.confidence,
            evidence: evidence,
            caveat: caveat
        )
    }

    private static func findModelText(in value: Any) -> String? {
        if let dictionary = value as? [String: Any] {
            for key in ["output_text", "text"] {
                if let text = dictionary[key] as? String, text.contains("summary") { return text }
            }
            for child in dictionary.values {
                if let found = findModelText(in: child) { return found }
            }
        } else if let array = value as? [Any] {
            for child in array {
                if let found = findModelText(in: child) { return found }
            }
        }
        return nil
    }

    private static func containsModelText(_ data: Data) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with: data) else { return false }
        return findModelText(in: json) != nil
    }

    private static func interactionID(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        for key in ["id", "name"] {
            guard var value = object[key] as? String else { continue }
            if value.contains("/") { value = String(value.split(separator: "/").last ?? "") }
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
            guard !value.isEmpty, value.count <= 200,
                  value.unicodeScalars.allSatisfy(allowed.contains) else { continue }
            return value
        }
        return nil
    }

    private static func interactionFailed(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = object["status"] as? String else { return false }
        return ["failed", "cancelled", "expired"].contains(status.lowercased())
    }

    private static func extractJSONObject(from text: String) -> String {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start <= end else { return text }
        return String(text[start...end])
    }

    private static func isSafePublicHTTPS(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), host.contains("."),
              !host.contains(":"), host != "localhost", !host.hasSuffix(".localhost"), !host.hasSuffix(".local") else { return false }
        let numbers = host.split(separator: ".").compactMap { Int($0) }
        if numbers.count == 4 {
            if [0, 10, 127].contains(numbers[0]) { return false }
            if numbers[0] == 169 && numbers[1] == 254 { return false }
            if numbers[0] == 172 && (16...31).contains(numbers[1]) { return false }
            if numbers[0] == 192 && numbers[1] == 168 { return false }
        }
        return true
    }
}
