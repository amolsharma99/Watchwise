import SwiftUI
import UserNotifications
import WatchwiseCore
import WatchwiseIntegrations
import AppKit
import UniformTypeIdentifiers

@main
struct WatchwiseApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Watchwise", systemImage: "play.square.stack") {
            MenuPanel(model: model)
        }
        .menuBarExtraStyle(.window)

        WindowGroup("Watchwise Insights", id: "insights") {
            DashboardView(model: model)
                .frame(minWidth: 660, minHeight: 520)
        }

        Settings {
            SettingsView(model: model)
                .frame(width: 560, height: 620)
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var preferences: UserPreferences {
        didSet {
            persistPreferences()
            persistBridgeSettings()
        }
    }
    @Published var today = ViewingInsights.empty(interval: InsightEngine.dayInterval(containing: Date(), calendar: .current))
    @Published var week = ViewingInsights.empty(interval: InsightEngine.weekInterval(containing: Date(), calendar: .current))
    @Published var recentNudge: Nudge?
    @Published var isShowingOnboarding = true
    @Published var isDemoData = true
    @Published var storageMessage: String?
    @Published var analysisState: AnalysisJobState?
    @Published var analysisMessage: String?
    @Published var lowInformationSuggestion: String?
    @Published var notificationStatusDescription: String?
    @Published var exclusionMessage: String?
    private let store: SQLiteViewingStore?
    private let bridgeSettingsURL: URL
    private let analysisService = GeminiAnalysisService()
    private let keyStore = KeychainAPIKeyStore()
    private let nudgeEngine = NudgeEngine()
    private var refreshTask: Task<Void, Never>?

    init() {
        if let data = UserDefaults.standard.data(forKey: "watchwise.preferences"),
           let saved = try? JSONDecoder().decode(UserPreferences.self, from: data) {
            preferences = saved
        } else {
            preferences = UserPreferences()
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Watchwise", isDirectory: true)
        bridgeSettingsURL = base.appendingPathComponent("bridge-settings.json", isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            store = try SQLiteViewingStore(path: base.appendingPathComponent("history.sqlite3").path)
        } catch {
            store = nil
            storageMessage = "Local history could not be opened. Nothing is being stored."
        }
        isShowingOnboarding = !preferences.trackingConsent
        persistBridgeSettings()
        refreshTask = Task { [weak self] in
            await self?.refreshInsightsAndNudges()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(20)) }
                catch { return }
                await self?.refreshInsightsAndNudges()
            }
        }
        Task { await refreshNotificationStatus() }
    }

    deinit { refreshTask?.cancel() }

    var movieModeActive: Bool { (preferences.movieModeUntil ?? .distantPast) > Date() }

    func completeOnboarding(enableTracking: Bool, enableAI: Bool, enableNotifications: Bool) {
        preferences.trackingConsent = enableTracking
        preferences.aiAnalysisConsent = enableAI
        preferences.notificationsEnabled = enableNotifications
        isShowingOnboarding = false
        if enableNotifications { Task { await requestNotificationPermission() } }
    }

    func toggleMovieMode() {
        preferences.movieModeUntil = movieModeActive ? nil : Date().addingTimeInterval(2 * 60 * 60)
    }

    func snooze(minutes: Int) {
        preferences.snoozedUntil = Date().addingTimeInterval(TimeInterval(minutes * 60))
    }

    func requestNotificationPermission() async {
        guard preferences.notificationsEnabled else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await refreshNotificationStatus()
    }

    func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            notificationStatusDescription = preferences.notificationsEnabled ? "Watchwise notifications are enabled." : "Watchwise notifications are off in the app."
        case .denied:
            notificationStatusDescription = "macOS has blocked Watchwise notifications. You can re-enable them in System Settings."
        case .notDetermined:
            notificationStatusDescription = preferences.notificationsEnabled ? "macOS will ask before Watchwise sends its first notification." : "Watchwise notifications are off in the app."
        @unknown default:
            notificationStatusDescription = "Notification permission is managed by macOS System Settings."
        }
    }

    func openSystemNotificationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }

    @discardableResult
    func addExcludedSite(_ input: String) -> Bool {
        do {
            let host = try ExcludedSiteNormalizer.normalize(input)
            preferences.excludedSites.insert(host)
            exclusionMessage = "Excluded \(host)."
            return true
        } catch {
            exclusionMessage = "Enter a public hostname such as youtube.com."
            return false
        }
    }

    func removeExcludedSite(_ host: String) {
        preferences.excludedSites.remove(host.lowercased())
        exclusionMessage = nil
    }

    func saveGeminiKey(_ key: String) {
        do {
            try keyStore.save(key)
            analysisMessage = "Gemini API key saved securely in Keychain."
        } catch {
            analysisMessage = "The API key could not be saved."
        }
    }

    func removeGeminiKey() {
        do {
            try keyStore.delete()
            analysisMessage = "Gemini API key removed from Keychain."
        } catch {
            analysisMessage = "The API key could not be removed."
        }
    }

    func analysePublicVideo(urlString: String, title: String) async {
        guard preferences.aiAnalysisConsent else {
            analysisMessage = "Turn on optional Gemini analysis in Settings first."
            return
        }
        guard let url = URL(string: urlString) else {
            analysisMessage = "Enter a valid public HTTPS video URL."
            return
        }
        if let host = url.host, preferences.isSiteExcluded(host) {
            analysisMessage = "This site is excluded from Watchwise analysis."
            return
        }
        do {
            let request = try VideoAnalysisRequest(url: url, title: title.isEmpty ? "Untitled video" : title)
            await analysisService.updatePrivacyContext(excludedSites: preferences.excludedSites, movieModeUntil: preferences.movieModeUntil)
            let jobID = try await analysisService.submit(request, consent: preferences.aiAnalysisConsent)
            analysisState = .queued
            analysisMessage = "Analysis queued. You can keep using your Mac."
            let updates = await analysisService.updates(for: jobID)
            for await state in updates {
                analysisState = state
                switch state {
                case .queued: analysisMessage = "Analysis queued."
                case .running: analysisMessage = "Gemini is reviewing the video…"
                case .succeeded(let result):
                    analysisMessage = "Summary ready."
                    if let first = result.skipSegments.first(where: { $0.endSeconds - $0.startSeconds >= 20 }) {
                        lowInformationSuggestion = "If you prefer, you could skip \(timestamp(first.startSeconds))–\(timestamp(first.endSeconds)): \(first.reason). This is only a suggestion."
                    } else if result.verdict == .probablySkip || result.verdict == .readSummary {
                        lowInformationSuggestion = "The summary may be enough for your goal. You can still watch the full video if context matters."
                    } else {
                        lowInformationSuggestion = nil
                    }
                    await notifyAnalysisComplete(success: true)
                case .failed(let message):
                    analysisMessage = message
                    await notifyAnalysisComplete(success: false)
                }
            }
        } catch {
            analysisState = .failed(message: error.localizedDescription)
            analysisMessage = error.localizedDescription
        }
    }

    private func notifyAnalysisComplete(success: Bool) async {
        guard preferences.notificationsEnabled,
              preferences.suppressionReason(at: Date(), site: "gemini-analysis", calendar: .current) == nil,
              await canDeliverNotifications() else { return }
        let content = UNMutableNotificationContent()
        content.title = success ? "Watchwise summary ready" : "Watchwise analysis stopped"
        content.body = success ? "Open Watchwise to review the summary and useful timestamps." : "Open Watchwise to see what needs attention."
        let request = UNNotificationRequest(identifier: "analysis-\(UUID().uuidString)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    func refreshInsights() async {
        await refreshInsightsAndNudges(allowNudge: false)
    }

    func refreshInsightsAndNudges(allowNudge: Bool = true) async {
        guard let store else { return }
        do {
            let now = Date()
            let calendar = Calendar.current
            let dayInterval = InsightEngine.dayInterval(containing: now, calendar: calendar)
            let weekInterval = InsightEngine.weekInterval(containing: now, calendar: calendar)
            let queryInterval = DateInterval(start: min(dayInterval.start, weekInterval.start), end: max(dayInterval.end, weekInterval.end))
            let events = try await store.events(in: queryInterval)
            today = InsightEngine.summarize(events: events, interval: dayInterval)
            week = InsightEngine.summarize(events: events, interval: weekInterval)
            isDemoData = false
            guard allowNudge,
                  let context = NudgeMetricsCalculator.context(
                    events: events.filter { dayInterval.contains($0.occurredAt) },
                    now: now,
                    dailyActiveSeconds: today.activeSeconds
                  ) else { return }
            let decision = await nudgeEngine.evaluate(context, preferences: preferences, calendar: calendar)
            guard case .success(let nudge?) = decision else { return }
            recentNudge = nudge
            await postNudgeNotification(nudge)
        } catch {
            storageMessage = "Insights could not be refreshed. Your existing history was not changed."
        }
    }

    private func postNudgeNotification(_ nudge: Nudge) async {
        guard await canDeliverNotifications() else { return }
        let content = UNMutableNotificationContent()
        content.title = nudge.title
        content.body = nudge.message
        content.categoryIdentifier = "WATCHWISE_NUDGE"
        let request = UNNotificationRequest(identifier: "nudge-\(nudge.id.uuidString)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    private func canDeliverNotifications() async -> Bool {
        guard preferences.notificationsEnabled else { return false }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if status == .denied {
            notificationStatusDescription = "macOS has blocked Watchwise notifications. You can re-enable them in System Settings."
            return false
        }
        return status == .authorized || status == .provisional
    }

    func deleteLocalHistory() async {
        guard let store else { return }
        do {
            try await store.deleteAll()
            await refreshInsights()
            storageMessage = "Local viewing history deleted."
        } catch {
            storageMessage = "History could not be deleted. Please try again."
        }
    }

    func exportLocalHistory() async {
        guard let store else { return }
        do {
            let data = try await store.exportJSON()
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "watchwise-history.json"
            panel.allowedContentTypes = [.json]
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try data.write(to: url, options: [.atomic])
            storageMessage = "History exported."
        } catch {
            storageMessage = "History could not be exported."
        }
    }

    private func persistPreferences() {
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        UserDefaults.standard.set(data, forKey: "watchwise.preferences")
    }

    private func persistBridgeSettings() {
        let settings = BridgePrivacySettings(
            trackingConsent: preferences.trackingConsent,
            excludedSites: preferences.excludedSites
        )
        guard let data = try? JSONEncoder().encode(settings) else { return }
        try? FileManager.default.createDirectory(
            at: bridgeSettingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: bridgeSettingsURL, options: [.atomic, .completeFileProtection])
    }

    private func timestamp(_ seconds: Double) -> String {
        String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

struct MenuPanel: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Today").font(.headline)
                    Text(duration(model.today.activeSeconds)).font(.title2.monospacedDigit())
                }
                Spacer()
                Label(model.movieModeActive ? "Movie Mode on" : "Nudges active", systemImage: model.movieModeActive ? "film" : "bell")
                    .font(.caption)
                    .foregroundStyle(model.movieModeActive ? .orange : .secondary)
            }

            if model.isShowingOnboarding {
                OnboardingCard(model: model)
            } else if !model.preferences.trackingConsent {
                ContentUnavailableView("Tracking is off", systemImage: "eye.slash", description: Text("Nothing is collected until you opt in from Settings."))
            } else {
                ProgressView(value: min(model.today.activeSeconds / model.preferences.dailyLimitSeconds, 1))
                Text("Daily target: \(duration(model.preferences.dailyLimitSeconds))")
                    .font(.caption).foregroundStyle(.secondary)
                if model.isDemoData {
                    Label("Waiting for the browser extension — no sample activity is stored.", systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if let storageMessage = model.storageMessage {
                Text(storageMessage).font(.caption).foregroundStyle(.secondary)
            }
            if let nudge = model.recentNudge {
                GroupBox {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(nudge.title).font(.headline)
                        Text(nudge.message).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            HStack {
                Button(model.movieModeActive ? "End Movie Mode" : "Movie Mode · 2h") { model.toggleMovieMode() }
                Menu("Snooze") {
                    Button("30 minutes") { model.snooze(minutes: 30) }
                    Button("1 hour") { model.snooze(minutes: 60) }
                    Button("3 hours") { model.snooze(minutes: 180) }
                }
            }
            Divider()
            Button("Open Insights") { openWindow(id: "insights") }
                .keyboardShortcut("i")
            SettingsLink { Text("Settings") }
            Button("Quit Watchwise") { NSApplication.shared.terminate(nil) }
        }
        .padding(16)
        .frame(width: 370)
    }
}

struct OnboardingCard: View {
    @ObservedObject var model: AppModel
    @State private var tracking = false
    @State private var ai = false
    @State private var notifications = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("Private by default", systemImage: "hand.raised.fill").font(.headline)
                Text("When enabled, Watchwise stores the page title, website/path, and playback timing locally. It does not record your screen, audio, captions, or page body.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Track video playback on websites", isOn: $tracking)
                Toggle("Allow optional Gemini summaries", isOn: $ai)
                    .disabled(!tracking)
                Toggle("Allow gentle Watchwise notifications", isOn: $notifications)
                    .disabled(!tracking)
                Text("AI analysis sends an eligible public video URL only after you request it. You can change this later.")
                    .font(.caption2).foregroundStyle(.secondary)
                Button("Continue") {
                    model.completeOnboarding(enableTracking: tracking, enableAI: ai && tracking, enableNotifications: notifications && tracking)
                }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

struct DashboardView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your viewing, in perspective").font(.largeTitle.bold())
                if model.isDemoData {
                    Label("Live insights appear after the browser extension connects.", systemImage: "info.circle")
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 14) {
                    InsightCard(title: "Today", value: duration(model.today.activeSeconds), note: "active viewing")
                    InsightCard(title: "This week", value: duration(model.week.activeSeconds), note: "active viewing")
                    InsightCard(title: "Completed", value: "\(model.week.videosCompleted)", note: "videos this week")
                }
                WeeklyDetails(insights: model.week)
                GroupBox("Designed to help, not judge") {
                    Text("Watchwise uses gentle, rate-limited check-ins. A low-information assessment is a suggestion—not a factual verdict—and Movie Mode silences it instantly.")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                }
                AnalysisPanel(model: model)
                Spacer(minLength: 20)
            }
            .padding(24)
        }
    }
}

struct WeeklyDetails: View {
    let insights: ViewingInsights

    var body: some View {
        GroupBox("This week") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("\(insights.videosStarted) started", systemImage: "play.circle")
                    Label("\(insights.videosCompleted) completed", systemImage: "checkmark.circle")
                }
                .font(.callout)
                if insights.sites.isEmpty {
                    Text("No viewing activity recorded this week.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Top sites").font(.headline)
                    ForEach(Array(insights.sites.prefix(5)), id: \.site) { site in
                        HStack {
                            Text(site.site).lineLimit(1)
                            Spacer()
                            Text(duration(site.activeSeconds)).monospacedDigit().foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
        }
    }
}

struct AnalysisPanel: View {
    @ObservedObject var model: AppModel
    @State private var url = ""
    @State private var title = ""

    var body: some View {
        GroupBox("Optional video summary") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Paste a public video URL. Nothing is sent until you press Analyse.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Public HTTPS video URL", text: $url)
                TextField("Video title (optional)", text: $title)
                HStack {
                    Button("Analyse with Gemini") { Task { await model.analysePublicVideo(urlString: url, title: title) } }
                        .disabled(!model.preferences.aiAnalysisConsent || url.isEmpty)
                    if case .running? = model.analysisState { ProgressView().controlSize(.small) }
                    if let message = model.analysisMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                }
                if case .succeeded(let result)? = model.analysisState {
                    Divider()
                    Text(result.summary).textSelection(.enabled)
                    Label(verdict(result.verdict), systemImage: "checkmark.seal")
                        .font(.headline)
                    Text("Confidence: \(Int(result.confidence * 100))% · \(result.caveat)")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(result.keyPoints.enumerated()), id: \.offset) { _, point in
                        Text("\(timestamp(point.seconds))  \(point.text)")
                            .font(.callout.monospacedDigit()).textSelection(.enabled)
                    }
                    if let suggestion = model.lowInformationSuggestion {
                        Label(suggestion, systemImage: "forward.end")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if !result.skipSegments.isEmpty {
                        Text("Optional skips").font(.headline)
                        ForEach(Array(result.skipSegments.enumerated()), id: \.offset) { _, segment in
                            Text("\(timestamp(segment.startSeconds))–\(timestamp(segment.endSeconds))  \(segment.reason)")
                                .font(.callout.monospacedDigit()).textSelection(.enabled)
                        }
                    }
                    if !result.evidence.isEmpty {
                        Text("Signals considered").font(.headline)
                        ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, evidence in
                            Text("• \(evidence)").font(.callout).textSelection(.enabled)
                        }
                        Text("These are model-observed signals, not externally verified facts.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
        }
    }

    private func verdict(_ value: ValueVerdict) -> String {
        switch value {
        case .worthWatching: "Worth watching"
        case .skim: "Skim"
        case .readSummary: "Read the summary"
        case .probablySkip: "Probably skip"
        case .uncertain: "Uncertain"
        }
    }

    private func timestamp(_ seconds: Double) -> String {
        String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

struct InsightCard: View {
    let title: String
    let value: String
    let note: String
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 4) {
                Text(value).font(.title2.bold().monospacedDigit())
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: { Text(title) }
        .frame(maxWidth: .infinity)
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var confirmDelete = false
    @State private var apiKey = ""
    @State private var excludedSiteInput = ""
    @State private var confirmRemoveKey = false

    var body: some View {
        Form {
            Section("Privacy") {
                Toggle("Track video playback on websites", isOn: $model.preferences.trackingConsent)
                    .onChange(of: model.preferences.trackingConsent) { _, enabled in
                        if !enabled { model.preferences.aiAnalysisConsent = false }
                    }
                Toggle("Allow Gemini analysis when requested", isOn: $model.preferences.aiAnalysisConsent)
                    .disabled(!model.preferences.trackingConsent)
                Text("No screen recording. History stays on this Mac unless you explicitly analyse a public URL.")
                    .font(.caption).foregroundStyle(.secondary)
                SecureField("Gemini API key", text: $apiKey)
                Button("Save API Key in Keychain") {
                    model.saveGeminiKey(apiKey)
                    apiKey = ""
                }
                .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Remove Gemini API Key…", role: .destructive) { confirmRemoveKey = true }
                if let message = model.analysisMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Excluded sites") {
                HStack {
                    TextField("example.com", text: $excludedSiteInput)
                    Button("Add") {
                        if model.addExcludedSite(excludedSiteInput) { excludedSiteInput = "" }
                    }
                    .disabled(excludedSiteInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                ForEach(model.preferences.excludedSites.sorted(), id: \.self) { site in
                    HStack {
                        Text(site)
                        Spacer()
                        Button("Remove", role: .destructive) { model.removeExcludedSite(site) }
                            .buttonStyle(.borderless)
                    }
                }
                if let message = model.exclusionMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
                Text("Excluded sites are not tracked, nudged, or sent for AI analysis.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Nudges") {
                Toggle("Allow Watchwise notifications", isOn: $model.preferences.notificationsEnabled)
                    .onChange(of: model.preferences.notificationsEnabled) { _, enabled in
                        Task {
                            if enabled { await model.requestNotificationPermission() }
                            else { await model.refreshNotificationStatus() }
                        }
                    }
                if let status = model.notificationStatusDescription {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
                Button("Open macOS Notification Settings") { model.openSystemNotificationSettings() }
                Toggle("Quiet hours (10 PM–8 AM)", isOn: $model.preferences.quietHoursEnabled)
                Stepper("Daily target: \(Int(model.preferences.dailyLimitSeconds / 60)) minutes", value: $model.preferences.dailyLimitSeconds, in: 15 * 60...8 * 60 * 60, step: 15 * 60)
            }
            Section("Control") {
                Toggle("Movie Mode", isOn: Binding(get: { model.movieModeActive }, set: { _ in model.toggleMovieMode() }))
                Button("Export local history…") { Task { await model.exportLocalHistory() } }
                Button("Delete all local history…", role: .destructive) { confirmDelete = true }
            }
        }
        .formStyle(.grouped)
        .padding()
        .confirmationDialog("Delete all local viewing history?", isPresented: $confirmDelete) {
            Button("Delete History", role: .destructive) { Task { await model.deleteLocalHistory() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This cannot be undone. Your settings and exclusions will be kept.")
        }
        .confirmationDialog("Remove the Gemini API key?", isPresented: $confirmRemoveKey) {
            Button("Remove API Key", role: .destructive) { model.removeGeminiKey() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("The key will be deleted from this Mac’s Keychain. Watchwise will not reveal or export it.")
        }
    }
}

private func duration(_ seconds: TimeInterval) -> String {
    let minutes = max(0, Int(seconds / 60))
    if minutes < 60 { return "\(minutes)m" }
    return "\(minutes / 60)h \(minutes % 60)m"
}
