import Foundation
import XCTest
import WatchwiseCore
@testable import WatchwiseIntegrations

private struct TestKeyProvider: APIKeyProviding {
    func apiKey() async throws -> String { "test-key-never-sent-live" }
}

private struct TestTransport: GeminiTransport {
    let statusCode: Int
    let responseText: String
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-goog-api-key"), "test-key-never-sent-live")
        XCTAssertNotEqual(request.url?.query?.contains("key="), true)
        let data = try JSONSerialization.data(withJSONObject: ["output_text": responseText])
        return (data, HTTPURLResponse(url: request.url!, statusCode: statusCode, httpVersion: nil, headerFields: nil)!)
    }
}

final class GeminiAnalysisServiceTests: XCTestCase {
    private var validResult: String {
        """
        {"summary":"A concise explanation.","keyPoints":[{"seconds":42,"text":"Main idea"}],"skipSegments":[{"startSeconds":0,"endSeconds":30,"reason":"Long introduction"}],"verdict":"skim","confidence":0.8,"evidence":["The same claim is repeated"],"caveat":"This is not an external fact-check."}
        """
    }
    private func request(_ url: String = "https://www.youtube.com/watch?v=abc") throws -> VideoAnalysisRequest {
        try VideoAnalysisRequest(url: URL(string: url)!, title: "Test video")
    }

    func testConsentIsRequiredBeforeQueueing() async throws {
        let service = service()
        do { _ = try await service.submit(request(), consent: false); XCTFail("Expected consent error") }
        catch { XCTAssertEqual(error as? AnalysisServiceError, .aiConsentRequired) }
    }

    func testRejectsPrivateAndExcludedDestinations() async throws {
        let service = service()
        do { _ = try await service.submit(request("https://localhost/video"), consent: true); XCTFail("Expected private URL error") }
        catch { XCTAssertEqual(error as? AnalysisServiceError, .unsafeOrPrivateURL) }
        await service.updatePrivacyContext(excludedSites: ["www.youtube.com"], movieModeUntil: nil)
        do { _ = try await service.submit(request(), consent: true); XCTFail("Expected excluded site error") }
        catch { XCTAssertEqual(error as? AnalysisServiceError, .siteExcluded) }
    }

    func testMovieModeBlocksSubmission() async throws {
        let service = service()
        await service.updatePrivacyContext(excludedSites: [], movieModeUntil: Date().addingTimeInterval(600))
        do { _ = try await service.submit(request(), consent: true); XCTFail("Expected Movie Mode error") }
        catch { XCTAssertEqual(error as? AnalysisServiceError, .movieModeActive) }
    }

    func testCompletesWithBoundedCautiousResult() async throws {
        let service = service()
        let jobID = try await service.submit(request(), consent: true)
        let state = try await service.waitForCompletion(jobID: jobID)
        guard case .succeeded(let result) = state else { return XCTFail("Expected successful analysis") }
        XCTAssertEqual(result.verdict, .skim)
        XCTAssertEqual(result.keyPoints.first?.seconds, 42)
        XCTAssertTrue(result.caveat.localizedCaseInsensitiveContains("not an external fact-check"))
    }

    func testServiceErrorsDoNotExposeResponseBody() async throws {
        let service = GeminiAnalysisService(keyProvider: TestKeyProvider(), transport: TestTransport(statusCode: 401, responseText: "secret provider response"))
        let jobID = try await service.submit(request(), consent: true)
        let state = try await service.waitForCompletion(jobID: jobID)
        guard case .failed(let message) = state else { return XCTFail("Expected failed analysis") }
        XCTAssertFalse(message.contains("secret provider response"))
    }

    private func service() -> GeminiAnalysisService {
        GeminiAnalysisService(keyProvider: TestKeyProvider(), transport: TestTransport(statusCode: 200, responseText: validResult))
    }
}
