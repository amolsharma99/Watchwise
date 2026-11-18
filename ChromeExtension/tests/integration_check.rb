#!/usr/bin/env ruby
require "json"

root = File.expand_path("..", __dir__)
manifest = JSON.parse(File.read(File.join(root, "manifest.json")))
content = File.read(File.join(root, "content.js"))
background = File.read(File.join(root, "background.js"))
panel = File.read(File.join(root, "sidepanel.html"))
options = File.read(File.join(root, "options.html"))
sidepanel_js = File.read(File.join(root, "sidepanel.js"))
sidepanel_css = File.read(File.join(root, "sidepanel.css"))
options_js = File.read(File.join(root, "options.js"))
nano_html = File.read(File.join(root, "nano-pilot.html"))
nano_js = File.read(File.join(root, "nano-pilot.js"))
auto_analysis = File.read(File.join(root, "lib", "auto-analysis.js"))
youtube = File.read(File.join(root, "lib", "youtube.js"))
gemini_protocol = File.read(File.join(root, "lib", "gemini-protocol.js"))
storage = File.read(File.join(root, "lib", "storage.js"))
goal_checkin = File.read(File.join(root, "lib", "goal-checkin.js"))
readme = File.read(File.join(root, "README.md"))
store_allowlist = File.readlines(File.join(root, "store-package-files.txt"), chomp: true).map(&:strip).reject { |line| line.empty? || line.start_with?("#") }
store_packager = File.read(File.join(root, "scripts", "package_store.rb"))

def assert(condition, message)
  raise message unless condition
end

assert(manifest["manifest_version"] == 3, "Manifest V3 required")
assert(manifest["version"] == "0.3.9", "Acknowledged goal check-in release must use extension version 0.3.9")
assert(manifest["minimum_chrome_version"] == "116", "Chrome 116 is required for sidePanel.open")
assert(manifest["host_permissions"] == ["https://*/*"], "Expected disclosed HTTPS host scope")
assert(manifest["incognito"] == "not_allowed", "Incognito must be disabled")
assert(!manifest.fetch("permissions", []).include?("nativeMessaging"), "Native messaging is forbidden")
assert(!manifest.fetch("permissions", []).include?("tabs"), "Broad HTTPS access already grants required tab URL fields; tabs permission is redundant")
assert(!manifest.fetch("permissions", []).include?("downloads"), "Explicit side-panel export must not require download-management access")
assert(manifest.fetch("permissions") == %w[alarms scripting sidePanel storage], "Store manifest permissions are not the exact reviewed minimum")
assert(manifest.fetch("permissions", []).include?("scripting"), "Existing-tab content recovery requires the scripting permission")
assert(manifest.dig("content_scripts", 0, "all_frames") == true, "All-frame tracking required")
assert(store_allowlist.first == "manifest.json", "Store archive must put manifest.json at its root")
%w[README.md AGENTS.md LEGACY_NOTES.md assets/icon.svg nano-pilot.html nano-pilot.css nano-pilot.js nano-sample.txt].each do |excluded|
  assert(!store_allowlist.include?(excluded), "Store package must exclude #{excluded}")
end
assert(store_allowlist.none? { |path| path.start_with?("tests/") }, "Store package must exclude tests")
assert(store_packager.include?("secret_patterns") && store_packager.include?("remote_code_patterns") && store_packager.include?("listing.lines.map(&:chomp) == files") && store_packager.include?("imports excluded module"), "Store packager lacks secret, remote-code, module-dependency or exact-entry validation")
{ "16" => 16, "32" => 32, "48" => 48, "128" => 128 }.each do |key, size|
  path = "assets/icon#{size}.png"
  assert(manifest.dig("icons", key) == path && manifest.dig("action", "default_icon", key) == path && store_allowlist.include?(path), "Missing packaged #{size}px icon")
end

assert(!content.include?("chrome.storage"), "Content script must not read storage")
assert(content.include?("IntersectionObserver"), "IntersectionObserver visibility gate missing")
assert(content.include?("MIN_VISIBLE_AREA_PX"), "Minimum visible area gate missing")
assert(content.include?("intersectionRatio >= MIN_VISIBLE_RATIO"), "Minimum intersection ratio gate missing")
assert(content.include?("metadata.intersecting = false"), "Visibility must fail closed until IntersectionObserver reports")
assert(!content.include?("getBoundingClientRect"), "Frame-local geometry must not initialize visibility")
assert(content.include?("terminateIfActive"), "Offscreen termination path missing")
assert(content.include?("emit(video, metadata, \"paused\", false, true)"), "Pause-style visibility termination missing")
assert(content.include?("Number.isFinite(livePosition) ? livePosition : metadata.lastPosition"), "Visibility termination must preserve the live final position")
assert(content.include?("rotateIdentityIfNeeded"), "Reused-player rotation missing")
assert(content.include?("metadata.id = uuid()"), "Player ID is not rotated")
assert(content.include?("url.search = \"\""), "Arbitrary page queries are not removed")
assert(content.include?("url.searchParams.set(\"v\", videoID)"), "YouTube v-only preservation missing")
assert(content.include?("hostname === \"youtube.com\" || hostname.endsWith(\".youtube.com\")"), "YouTube hostname matching is not exact")
assert(!content.include?("url.hostname.endsWith(\"youtube.com\")"), "Lookalike YouTube hostnames would retain queries")
assert(!content.match?(/searchParams\.set\((?!["']v["'])/), "Unexpected query parameter is retained")
assert(!content.match?(/api[_-]?key|gemini/i), "Content messages mention AI credentials")
assert(content.include?("video.getAttribute(\"title\")") && content.include?("video.getAttribute(\"aria-label\")"), "Video title fallback does not use minimized media attributes")
assert(content.include?("navigator.mediaSession?.metadata?.title"), "Media Session title is not preferred")
allowed_title_selectors = [
  "document.querySelector('meta[property=\"og:title\"]')",
  "document.querySelector('meta[name=\"twitter:title\"]')",
  "document.querySelector('[data-uia=\"video-title\"]')",
  "document.querySelector('[data-uia=\"player-title\"]')"
]
allowed_title_selectors.each { |selector| assert(content.include?(selector), "Missing strict title selector: #{selector}") }
title_section = content[/function mediaTitle\(video\).*?\n  \}/m]
remaining_title_section = title_section.dup
allowed_title_selectors.each { |selector| remaining_title_section = remaining_title_section.gsub(selector, "") }
assert(!remaining_title_section.include?("document.querySelector("), "Media title extraction uses a non-allow-listed selector")
assert(!title_section.match?(/document\.body|querySelectorAll|innerText/), "Media title extraction scans arbitrary page-body text")
assert(title_section.include?("isNetflixWatch") && title_section.include?("/^\\/watch\\//"), "Netflix player selectors are not restricted to watch pages")
assert(content.include?("function netflixPlayerMetadataTitle(node)") && content.include?("Array.from(node.childNodes || [])") && content.include?("parts.join(\" \")"), "Netflix player title does not preserve spaces between immediate metadata children")
candidate_order = title_section[/for \(const candidate of \[(.*?)\]\)/m]
assert(candidate_order && candidate_order.index("metadataTitle") < candidate_order.index("netflixPlayerTitle") && candidate_order.index("netflixPlayerTitle") < candidate_order.index("openGraphTitle"), "Netflix current-player metadata does not outrank stale page-head metadata")
assert(content.include?("slice(0, 300)"), "Media titles are not capped")
assert(content.include?("? \"YouTube Short\""), "Canonical Shorts lack the explicit generic title fallback")
assert(content.include?("title: mediaTitle(video)"), "Playback events do not use the minimized title helper")
assert(!content.match?(/ytd-reel|shorts.*?textContent/i), "Content script scrapes Shorts page-body metadata")

access_index = background.index("setAccessLevel({ accessLevel: \"TRUSTED_CONTEXTS\" })")
first_get_index = background.index("chrome.storage.local.get")
assert(access_index && first_get_index && access_index < first_get_index, "Trusted-context storage protection must precede reads")
assert(background.include?("\"x-goog-api-key\": key"), "Gemini key must use the header")
assert(manifest["host_permissions"].include?("https://*/*"), "Gemini HTTPS host permission is missing")
assert(background.include?("credentials: \"omit\"") && background.include?("referrerPolicy: \"no-referrer\""), "Gemini fetch privacy options are missing")
assert(!background.match?(/[?&](?:key|api_key)=/i), "Gemini key must not appear in a URL")
assert(!background.match?(/console\.(?:log|debug|info|warn|error)/), "Background must not log data or keys")
assert(sidepanel_js.include?('import { IndexedDBRepository } from "./lib/storage.js";') && sidepanel_js.include?("repository.exportData(dashboard?.settings ?? {})"), "Side-panel export must read IndexedDB directly with safe dashboard settings")
assert(sidepanel_js.include?("new Blob") && sidepanel_js.include?("URL.createObjectURL(blob)") && sidepanel_js.include?("URL.revokeObjectURL(url)"), "Side-panel export must use a temporary local object URL")
assert(!background.include?("EXPORT_HISTORY") && !background.include?("chrome.downloads"), "Background must not manage downloads or receive exported history")
assert(!sidepanel_js.match?(/exportData\([^\n]*(?:API_KEY|geminiApiKey)/), "Export must not receive a key")

assert(background.include?("const settings = await getSettings();\n  if (!settings.aiEnabled) return;"), "Restart must stop when AI consent is disabled")
assert(background.include?("if (action === \"submit\") await submitAnalysis(job, historyGeneration)"), "Restart submit actions are not resumed idempotently")
assert(background.scan("const action = restartAction(job, nowMs);").length == 1, "Each persisted job must have exactly one restart action")
assert(background.match?(/for \(const job .*?\) \{\s*try \{/m), "Restart failures are not isolated per job")
assert(background.include?("type: \"REFRESH_TRACKING_STATE\""), "Settings broadcasts must request per-frame refresh")
assert(content.include?("refreshTrackingState()"), "Frames do not re-request their own tracking state")
assert(content.include?("watchwise-tracker-v0.3.9") && background.include?("watchwise-tracker-v0.3.9") && content.include?("__watchwiseContentLifecycle"), "Content lifecycle guard is not revisioned consistently")
assert(!content.include?("watchwise-tracker-v0.3.7") && !background.include?("watchwise-tracker-v0.3.7"), "Old content lifecycle can still be accepted")
assert(content.include?("await previousController.probe()") && content.include?("previousController?.deactivate?.()"), "Stale content instances are not health-checked and deactivated")
assert(content.include?("globalThis[CONTROLLER_KEY] !== startupClaim"), "Repeated recovery lacks an idempotent startup claim")
assert(content.include?("intersectionObserver.disconnect()") && content.include?("mutationObserver.disconnect()") && content.include?("removeListener?.(handleRuntimeMessage)"), "Stale content teardown is incomplete")
deactivate_section = content[/function deactivateLifecycle\(preserveFinalInterval = true\).*?\n  \}/m]
assert(deactivate_section&.include?("if (!preserveFinalInterval)") && deactivate_section.include?("stopTracking(preserveFinalInterval)"), "Invalidation and graceful replacement teardown are not separated")
assert(content.scan("chrome.runtime.sendMessage").length == 1 && content.include?("function sendRuntimeMessage(message)"), "Content runtime sends do not use the guarded wrapper")
assert(content.include?("void sendRuntimeMessage({ type: \"TOAST_ACTION\"") && content.include?("return sendRuntimeMessage({ type: \"CONTENT_READY\""), "Toast or refresh messaging can throw synchronously outside the guarded wrapper")
assert(content.include?("deactivateLifecycle(false)") && !content.downcase.include?("receiving end does not exist"), "Invalidation classification can dispose on transient receiving-end failures")
assert(content.include?("setTrackingState(false);") && content.include?("response?.ok !== true"), "Failed or non-ok tracking refresh does not fail closed")
assert(content.match?(/function setTrackingState.*?trackingEnabled = false;\s*stopTracking\(false\)/m), "Explicit/local tracking off can attempt final playback telemetry")
assert(content.include?("const requestEpoch = ++refreshEpoch") && content.include?("requestEpoch !== refreshEpoch"), "Out-of-order tracking refresh responses are not rejected")
assert(content.include?("MAX_REFRESH_RETRIES = 3") && content.include?("2 ** refreshRetryAttempts"), "Tracking refresh retry is not bounded with backoff")
assert(content.match?(/TRACKING_STATE.*?refreshEpoch \+= 1;.*?clearTimeout\(refreshRetryTimer\).*?setTrackingState/m), "Direct tracking state does not invalidate pending refreshes and retries")
assert(content.include?("new AbortController()") && content.include?("signal: lifecycleAbortController.signal") && content.include?("lifecycleAbortController.abort()"), "Lifecycle teardown can accumulate anonymous DOM listeners")
assert(content.include?("CONTENT_HEALTH_PROBE") && background.include?("CONTENT_HEALTH_CHECK"), "Content lifecycle health handshake is incomplete")
assert(background.include?("chrome.tabs.query({ url: \"https://*/*\" })"), "Recovery is not restricted to existing HTTPS tabs")
assert(background.include?("target: { tabId: tab.id, allFrames: true }") && background.include?("files: [\"content.js\"]"), "Recovery does not inject the tracker into every eligible frame")
assert(background.include?("target: { tabId: tab.id, frameIds: [0] }"), "Recovery lacks a main-frame fallback when an inaccessible child frame rejects all-frame injection")
assert(background.match?(/async function recoverExistingContentScripts.*?if \(!settings\.trackingEnabled\) return;/m), "Tracking-off state can trigger programmatic content injection")
assert(background.match?(/async function recoverContentScriptInTab.*?health\.live && health\.trackingEnabled.*?return true;.*?health\.live.*?refreshContentScriptState.*?probeContentScript.*?injectContentScript/m), "Recovery does not distinguish healthy, fail-closed, and missing content instances")
assert(content.include?("lifecycle: CONTENT_LIFECYCLE, trackingEnabled") && background.include?("trackingEnabled: response?.trackingEnabled === true"), "Content health does not expose local tracking state")
assert(content.include?("function safeRespond(sendResponse, payload)") && content.scan("sendResponse(").length == 1, "Runtime response ports are not guarded consistently")
assert(content.match?(/REFRESH_TRACKING_STATE.*?refreshTrackingState\(\)\.then\(.*?safeRespond\(sendResponse, \{ ok \}\).*?safeRespond\(sendResponse, \{ ok: false \}\).*?return true;/m), "Content refresh message does not settle one guarded response while keeping its channel open")
assert(background.match?(/async function refreshContentScriptState.*?chrome\.tabs\.sendMessage\(tabID, \{ type: "REFRESH_TRACKING_STATE" \}\)/m), "Fail-closed content recovery does not issue one all-frame refresh")
assert(background.include?("if (settings.trackingEnabled) void recoverExistingContentScripts(settings);"), "Turning tracking on does not recover stale open tabs")
assert(background.scan("then(recoverExistingContentScripts)").length >= 2, "Recovery does not run during initialization and installation")
assert(background.include?("chrome.runtime.onStartup.addListener") && background.include?("await recoverExistingContentScripts();"), "Startup does not recover existing tabs")
assert(background.include?("chrome.tabs.onActivated.addListener") && background.include?("await recoverContentScriptInTab(tab, settings)"), "Activated tabs are not consent-gated, probed and recovered")
assert(background.match?(/CONTENT_READY.*?sender\.frameId === 0.*?announceDashboardUpdated/m), "A recovered top frame does not settle the side-panel connection state")
assert(background.include?("trackingConnection: await activeTabTrackingConnection(activeTab, settings)"), "Dashboard lacks active-tab tracker health")
assert(background.match?(/async function activeTabTrackingConnection.*?if \(health\.live\).*?refreshContentScriptState.*?reconnecting.*?if \(!\(await recoverContentScriptInTab/m), "Live fail-closed tracker can be mislabeled as reload-required")
assert(sidepanel_js.include?("Tracker connected") && sidepanel_js.include?("Tracking on · reconnecting") && sidepanel_js.include?("Tracking on · reload video tab"), "Tracking pill lacks recovery states")
assert(sidepanel_js.include?("Tracking off here · excluded"), "Tracking pill can imply that global consent overrides a site exclusion")
assert(background.include?("historyGeneration += 1"), "Delete generation guard missing")
assert(background.include?("generation !== historyGeneration"), "Late job write guard missing")
delete_section = background[/case "DELETE_HISTORY": \{.*?return \{ ok: true \};\s*\}/m]
assert(delete_section&.include?("withDataMutation(async () => {"), "Delete is not serialized with job writes")
assert(delete_section&.include?("sessions.clear();"), "Delete does not clear in-memory playback sessions")
assert(delete_section&.include?("await repository.deleteAll();"), "Delete does not clear IndexedDB inside the mutation queue")
assert(delete_section&.include?("await localSet({ [ANALYSIS_SOURCES_KEY]: {}, [NUDGE_STATE_KEY]: {}, [GOAL_CHECK_STATE_KEY]: {} });"), "Delete does not serialize source/nudge/goal metadata clearing")
prune_section = background[/async function pruneRetainedData\(beforeMs\).*?^}/m]
assert(prune_section&.match?(/withDataMutation.*?repository\.prune\(beforeMs\).*?repository\.listAnalysisJobs\(\).*?localGet\(ANALYSIS_SOURCES_KEY\).*?retainAnalysisSourcesForJobs.*?localSet\(\{ \[ANALYSIS_SOURCES_KEY\]: retainedSources \}\)/m), "Retention pruning does not serialize IndexedDB and analysis-source cleanup")
assert(background.include?("await pruneRetainedData(Date.now() - RETENTION_MS);") && background.include?("if (alarm.name === PRUNE_ALARM) void pruneRetainedData"), "Analysis-source cleanup must run during initialization and scheduled pruning")
assert(!prune_section.match?(/localSet\([^\n]*(?:API_KEY|SETTINGS_KEY)/), "Retention cleanup can mutate the API key or settings")
assert(delete_section&.include?("await announceDashboardUpdated({ immediate: true });"), "Delete does not immediately refresh open dashboards")
assert(background.match?(/const event = await withDataMutation\(async \(\) => \{.*?const sessionID = await resolveSessionID.*?repository\.putEvent\(validated\)/m), "Session resolution and event persistence are not serialized with deletion")
assert(background.match?(/async function ingestPlayback.*?const generation = historyGeneration;.*?const settings = await getSettings\(\);.*?const revision = settingsRevision;.*?const event = await withDataMutation\(async \(\) => \{\s*if \(generation !== historyGeneration \|\| revision !== settingsRevision\) return null;\s*const sessionID = await resolveSessionID.*?if \(!event\) return \{ accepted: false \};/m), "In-flight playback can persist after deletion or a privacy-settings revision")
assert(background.match?(/const sessionID = await resolveSessionID.*?if \(generation !== historyGeneration \|\| revision !== settingsRevision\) \{\s*sessions\.clear\(\);\s*return null;\s*\}.*?const validated = validatePlaybackEvent/m), "Playback does not re-check privacy state after asynchronous session resolution")
assert(background.include?("const sourceStored = await withDataMutation(async () => {"), "Analysis source persistence is not serialized with deletion")
assert(background.match?(/sourceStored.*?generation !== historyGeneration.*?repository\.getAnalysisJob.*?localGet\(ANALYSIS_SOURCES_KEY\).*?generation !== historyGeneration.*?repository\.getAnalysisJob.*?localSet/m), "Source metadata lacks generation/job checks inside its mutation")

assert(gemini_protocol.include?("step.type !== \"model_output\""), "Provider output extraction is not restricted to model_output steps")
assert(!gemini_protocol.include?("for (const child of Object.values(value))"), "Provider output still recursively scans user/thought text")
assert(gemini_protocol.match?(/input:\s*\[\s*\{ type: \"text\".*?\},\s*\{ type: \"video\"/m), "Gemini request must place the instructions before the public video")
assert(gemini_protocol.include?("store: true"), "Stored interaction retrieval is not enabled")
assert(gemini_protocol.include?("response_format:"), "Structured Gemini response format is missing")
assert(!gemini_protocol.include?("maxItems") && !gemini_protocol.include?("maxLength"), "Provider schema uses unsupported/high-complexity constraints")
assert(gemini_protocol.include?("at most 8 key points") && gemini_protocol.include?("at most 6 skip segments") && gemini_protocol.include?("at most 8 evidence signals"), "Prompt does not carry application output caps")
assert(gemini_protocol.include?("api_key_invalid") && gemini_protocol.include?("api key not valid"), "HTTP 400 invalid-key responses are not classified as authentication failures")
assert(background.include?("createInteraction((request) => fetchGemini"), "Background-unsupported fallback is not wired to submission")

provider_fixture = {
  "status" => "completed",
  "steps" => [
    { "type" => "user_input", "content" => [{ "text" => "Return a summary as JSON" }] },
    { "type" => "thought", "content" => [{ "text" => "Considering the summary" }] },
    { "type" => "model_output", "content" => [{ "text" => '{"summary":"model wins"}' }] }
  ]
}
def contract_output_text(data)
  return data["output_text"] if data["output_text"].is_a?(String) && !data["output_text"].strip.empty?
  Array(data["steps"]).reverse_each do |step|
    next unless step.is_a?(Hash) && step["type"] == "model_output"
    return step["output_text"] if step["output_text"].is_a?(String) && !step["output_text"].strip.empty?
    texts = Array(step["content"]).each_with_object([]) do |item, values|
      values << item["text"] if item.is_a?(Hash) && item["text"].is_a?(String) && !item["text"].strip.empty?
    end
    return texts.join("\n") unless texts.empty?
  end
  nil
end
assert(contract_output_text(provider_fixture) == '{"summary":"model wins"}', "Model output does not win over summary text in user_input/thought steps")

def contract_disposition(status)
  return "pending" if %w[queued in_progress].include?(status)
  return "completed" if status == "completed"
  "failed"
end
%w[queued in_progress].each { |status| assert(contract_disposition(status) == "pending", "#{status} must remain pending") }
%w[failed cancelled incomplete budget_exceeded requires_action expired unknown].each { |status| assert(contract_disposition(status) == "failed", "#{status} must fail safely") }
assert(contract_disposition("completed") == "completed", "completed disposition missing")
assert(gemini_protocol.include?("if ([\"queued\", \"in_progress\"].includes(status)) return \"pending\";"), "Only queued/in_progress should remain pending")
assert(background.scan("if (disposition === \"failed\") return failJob").length >= 2, "Failed/unsupported provider states can be re-polled or accepted")
assert(background.scan("classifyInteractionFailure(data)").length == 2, "Terminal Interaction errors must keep their safe category in submit and poll paths")
assert(background.scan("if (disposition === \"completed\") {").length >= 2, "Completed states are not handled terminally")
assert(background.scan(/return result \? completeJob\(.*?\) : failJob\(.*?"provider_response"/).length >= 2, "Completed responses without valid model JSON do not fail")
%w[provider_auth provider_quota provider_invalid_request provider_model_unsupported provider_background_unsupported provider_video_unavailable provider_network provider_service_error provider_timeout provider_response provider_failed provider_unavailable].each do |code|
  assert(background.include?("#{code}:"), "Missing actionable UI mapping for #{code}")
end

assert(!manifest.fetch("permissions", []).include?("notifications"), "Native notification permission must be removed")
assert(!background.include?("chrome.notifications"), "Background still creates or manages native notifications")
assert(background.include?("text: \"Your Watchwise analysis is ready.\"") && background.include?("actionLabel: \"View summary\""), "Analysis completion lacks its in-page source-tab alert")
assert(background.include?("interventionsAllowed(settings, nowMs)"), "Completion suppression gate missing")
assert(background.include?("interventionsAllowed(currentSettings, Date.now(), event.pageSite, event.frameSite)"), "Nudge frame/page suppression re-check missing")
assert(background.include?("clearInterventions()") && background.include?("type: \"HIDE_TOAST\""), "Suppression must clear pending in-page toasts")

assert(panel.include?("safe settings—never the API key"), "Export disclosure is inaccurate")
assert(panel.include?("arbitrary page-body text") && options.include?("arbitrary page-body text"), "Privacy copy must distinguish strict metadata from arbitrary page-body scraping")
assert(panel.include?("Netflix /watch/ pages") && options.include?("Netflix /watch/ pages") && panel.include?("exact player-title metadata") && options.include?("exact player-title metadata"), "Netflix title metadata fallback is not disclosed precisely")
assert(!options.include?("nano-pilot.html"), "Experimental Nano pilot must not be linked from the public Options page")
assert(panel.include?("directly to Google Gemini") && options.include?("directly to Google Gemini"), "AI consent does not identify Google as the receiving third party")
assert(panel.include?("public YouTube URL and analysis instructions") && options.include?("public YouTube URL and analysis instructions"), "AI consent does not disclose the data sent to Google")
assert(panel.include?("except when sent over HTTPS to Google") && options.include?("except when it is sent over HTTPS to Google"), "API-key transfer disclosure is missing")
assert(options.include?("Public YouTube video URLs; requires your saved Gemini API key"), "Options does not disclose automatic-analysis scope/key requirement")
assert(options.include?("each new video may use paid Gemini API quota"), "Options does not disclose automatic API cost")
assert(background.include?("if ([\"playing\", \"heartbeat\"].includes(event.state) && event.isVisible && event.isTabActive)"), "Automatic analysis is not restricted to active visible playback progress")
assert(background.include?("async function maybeStartAutomaticAnalysis(event, generation = historyGeneration)"), "Automatic analysis orchestration is missing")
assert(background.include?("await maybeStartAutomaticAnalysis(event, generation)"), "Automatic analysis can outlive the playback event's history generation")
assert(background.include?("const activeWatchedSeconds = activeSessionSeconds(streamEvents, event.occurredAtMs) ?? 0;"), "Automatic analysis does not require meaningful watched progress")
assert(background.include?("const existingJobs = await repository.listAnalysisJobs();"), "Automatic analysis lacks durable job deduplication")
assert(background.include?("origin: \"automatic\""), "Automatic jobs are not restart-identifiable")
assert(auto_analysis.include?("if (!settings.autoAnalysisEnabled)"), "Automatic-analysis setting is not enforced by the paid-request gate")
assert(background.scan("automaticJobSubmissionAllowed(job, settings").length >= 3, "Paid automatic submission gates are not rechecked before submit, poll, and restart")
assert(panel.include?("id=\"autoAnalysisEnabled\""), "Side panel lacks the automatic-analysis control")
assert(panel.include?("may use paid API quota"), "Side panel lacks automatic Gemini cost disclosure")
assert(!sidepanel_js.match?(/autoAnalysisEnabled.*?\.disabled|\.disabled.*?autoAnalysisEnabled/), "Side-panel automatic-analysis preference is disabled before AI consent")
assert(!options_js.include?("autoAnalysis.disabled"), "Options automatic-analysis preference is disabled before AI consent")
assert(background.include?("const enriched = await enrichAnalysisJob(existingJob, generation);"), "Existing manual analysis is not enriched for immediate display")
assert(background.match?(/async function enrichAnalysisJob.*?getAnalysisResult\(current\.jobID\).*?ANALYSIS_SOURCES_KEY.*?result,.*?source:/m), "Existing completed analysis does not return its saved result and source")

insights = File.read(File.join(root, "lib", "insights.js"))
assert(insights.include?("previous.isYouTubeShort && candidate.isYouTubeShort"), "Near-zero churn deduplication is not restricted to canonical Shorts")
assert(youtube.include?("export function isUnidentifiedYouTubeURL") && youtube.include?("export function youtubeVideoIdentity"), "Shared neutral YouTube policy helpers are missing")
assert(insights.include?("events.filter((event) => !isUnidentifiedYouTubeURL(event.url))"), "Unidentified YouTube feed previews leak into insight metrics")
assert(background.match?(/async function ingestPlayback.*?isUnidentifiedYouTubeURL\(raw\.url\).*?withDataMutation.*?resolveSessionID/m), "Unidentified YouTube previews can reach session resolution or persistence")
assert(storage.scan("!isUnidentifiedYouTubeURL(event.url)").length >= 2, "Legacy unidentified YouTube previews can leak into exports")
assert(insights.include?("const overlapsProgress = previous && progressGapMs <= 0;"), "Overlapping streams of one canonical video are double-counted")
assert(insights.include?("const SHORT_CHURN_DEDUPE_MS = 3_000;"), "Near-zero Short churn uses an overly broad dedupe window")
assert(background.include?("if (!event) return { accepted: false };\n  void announceDashboardUpdated();"), "Accepted playback does not immediately refresh open dashboards")
assert(background.include?("const DASHBOARD_UPDATE_INTERVAL_MS = 1_000;"), "Playback dashboard invalidations are not rate-limited")
assert(background.include?("if (dashboardUpdateTimer) return Promise.resolve();"), "Concurrent dashboard invalidations are not coalesced")
assert(background.scan("chrome.runtime.sendMessage({ type: \"DASHBOARD_UPDATED\" })").length == 1, "Dashboard invalidation must use one outbound path")
assert(background.include?("if (message?.type === \"DASHBOARD_UPDATED\") return { ok: true };"), "Background does not benignly consume its own dashboard invalidation")
assert(background.include?("extensionVersion: chrome.runtime.getManifest().version"), "Dashboard state lacks a runtime version marker")
assert(panel.include?("id=\"buildVersion\""), "Side panel does not display the installed build version")
assert(sidepanel_js.include?("const sequence = ++refreshSequence;"), "Dashboard refreshes can render out of order")
assert(sidepanel_js.include?("if (sequence === refreshSequence) render(state);"), "Stale dashboard responses are not discarded")
assert(!sidepanel_js.include?("render(response.state)"), "A direct mutation render can be overwritten by an older refresh")
assert(sidepanel_js.scan("invalidateFullStateRequests();").length >= 2, "Settings/onboarding do not invalidate in-flight full-state reads")
assert(background.include?("if (persisted) await broadcastAnalysisJob(job, generation);"), "Persisted intermediate analysis states are not broadcast")
assert(sidepanel_js.include?("remote: \"Gemini accepted the video; waiting for processing…\""), "Remote analysis status has no user-facing label")
assert(sidepanel_js.include?("if (job && !shouldAcceptAnalysisJobUpdate(renderedAnalysisJob, job)) return;"), "Stale analysis job updates can overwrite newer states")
assert(sidepanel_js.match?(/ANALYSIS_JOB_UPDATED.*?invalidateFullStateRequests\(\);.*?renderJob/m), "Analysis broadcasts do not invalidate older dashboard reads")
assert(sidepanel_js.include?("title.title = fullTitle;"), "Full video title tooltip is missing")
assert(sidepanel_css.include?("-webkit-line-clamp:2") && sidepanel_css.include?("overflow-wrap:anywhere"), "Video titles are not readable over two lines")
assert(readme.include?("Updating the unpacked build to v0.3.9") && readme.include?("header reads **v0.3.9**"), "Reload-unpacked/version verification guidance is missing")
assert(readme.include?("one-time reload") && readme.include?("cannot retroactively repair"), "Existing orphaned content-script reload limitation is undocumented")
assert(nano_html.include?("id=\"checkAvailability\"") && nano_html.include?("id=\"summarize\" disabled") && nano_html.include?("id=\"assess\" disabled"), "Nano capability checks are not explicitly user-initiated")
assert(!nano_js.include?("await Promise.all([\n  checkAvailability") && nano_js.include?("#checkAvailability") && nano_js.include?("LanguageModel.availability()") && nano_js.include?("LanguageModel.availability(promptOptions)"), "Nano availability flow does not show base and configured user-initiated checks")
assert(nano_js.include?("if (!runnableAvailability.has(base))") && nano_js.index("if (!runnableAvailability.has(base))") < nano_js.index("const configured = await LanguageModel.availability(promptOptions)"), "Nano configured Prompt check runs when the base API is unavailable")
assert(nano_js.include?("const availability = await LanguageModel.availability(promptOptions);") && nano_js.index("const availability = await LanguageModel.availability(promptOptions);") < nano_js.index("session = await LanguageModel.create"), "Nano configured capability is not rechecked immediately before create")
assert(nano_js.include?("This local trial is separate from Watchwise tracking and Gemini analysis."), "Nano unavailable copy overclaims about unrelated tracking health")
assert(nano_js.include?("try { session?.destroy(); } catch {}") && nano_js.include?("try { summarizer?.destroy(); } catch {}"), "Nano model cleanup can throw from finally")
assert(readme.include?("does not probe Chrome's local models or load the transcript on page load") && readme.include?("native model-capability warning"), "Nano user-initiated/native-warning limitation is undocumented")
assert(readme.include?("Safe Gemini live test") && readme.include?("https://www.youtube.com/watch?v=9hE5-98ZeCg") && readme.include?("never share the API key"), "Controlled one-request Gemini test guidance is missing")
assert(readme.include?("homepage/feed playback without a canonical video ID is rejected before local persistence"), "Anonymous YouTube preview persistence policy is undocumented")
assert(insights.include?("youtubeVideoIdentity(event.url)"), "Video breakdown does not use shared YouTube identity")
assert(insights.include?("shareSeconds = (nextTime - time) / 1000 / activeVideoCounts.size"), "Overlapping video attribution is not split overlap-safely")
assert(sidepanel_js.include?("url.protocol === \"https:\""), "Video breakdown links are not HTTPS-gated")
assert(sidepanel_js.include?("link.rel = \"noopener noreferrer\""), "Video breakdown links lack safe opener isolation")
assert(panel.include?("rows add up to the overall total"), "Per-video overlap semantics are not disclosed")

assert(goal_checkin.include?("export function goalCheckInMessage") && goal_checkin.include?("GOAL_CHECKIN_MESSAGE"), "Context-aware goal check-in copy is missing")
assert(goal_checkin.include?("GOAL_CHECKIN_THRESHOLD_SECONDS = 15") && goal_checkin.include?("GOAL_CHECKIN_MIN_GAP_MS = 60_000"), "Goal threshold or anti-spam gap is incorrect")
assert(!goal_checkin.match?(/HOURLY_LIMIT|hourly_limit/), "Goal check-in has an unauthorized hourly cap")
assert(goal_checkin.include?("MAX_PROCESSED_IDENTITIES = 200") && goal_checkin.include?("PROCESSED_RETENTION_MS = 24 * 60 * 60_000"), "Goal processed identity retention is not bounded to 24h/200")
assert(goal_checkin.include?("rawState?.schemaVersion !== 2") && goal_checkin.include?("schemaVersion: 2, processed: [], pending: []"), "Unverified v0.3.8 goal state is not discarded")
assert(goal_checkin.include?("RESERVATION_LEASE_MS = 30_000") && goal_checkin.include?("MAX_DELIVERY_ATTEMPTS = 3"), "Goal reservation lease/retry is not concurrency-safe and bounded")
fail_section = goal_checkin[/export function failGoalCheckInReservation.*?\n\}/m]
assert(fail_section && !fail_section.include?("state.processed") && fail_section.include?("5 * 60_000"), "Unacknowledged delivery can be marked processed instead of retained with capped cooldown")
assert(goal_checkin.include?("mediaDelta > wallSeconds * previous.playbackRate * 1.5 + 2"), "Goal progress accepts seek jumps")
assert(goal_checkin.include?("event.tabID !== targetEvent.tabID") && goal_checkin.include?("interval[0] - cluster.endMs > 30_000") && goal_checkin.include?("targetEvent.occurredAtMs - latestCluster.endMs > 30_000"), "Goal progress combines tabs or stale viewing episodes")
assert(goal_checkin.include?("isExcludedSite(event.pageSite, settings) || isExcludedSite(event.frameSite, settings)"), "Goal suppression does not cover both frame and page sites")
assert(goal_checkin.match?(/if \(suppression\).*?nextState\.processed.*?return Object\.freeze/m), "Suppressed goal threshold is not marked processed")
assert(goal_checkin.match?(/suppression: "cadence".*?state: Object\.freeze\(nextState\)/m), "Cadence-blocked goal does not remain pending")
assert(goal_checkin.include?("type: \"SHOW_TOAST\", text: message, priority: \"goal_checkin\"") && goal_checkin.include?("response?.shown === true") && !goal_checkin.include?("actionLabel"), "Goal toast does not require the acknowledged context message")
assert(background.include?("message: decision.message") && background.include?("message: reservation.message"), "Goal copy is not carried from evaluation to delivery")
assert(!goal_checkin.include?("browser.notifications") && !goal_checkin.include?("nudge:goal:"), "Goal check-in still creates a native notification")
assert(content.include?("message.priority === \"goal_checkin\"") && content.include?("{ ok: true, shown }") && content.include?("fullscreenRoot || document.documentElement") && content.include?("fullscreenRoot instanceof HTMLVideoElement") && content.include?("fullscreenRoot instanceof HTMLIFrameElement"), "Content toast does not acknowledge actual/container-fullscreen priority display")
assert(goal_checkin.include?("export function isGoalPlaybackActive") && goal_checkin.include?("nowMs - latest.occurredAtMs <= freshnessMs"), "Goal delivery does not require fresh active playback")
assert(background.include?("const GOAL_CHECK_STATE_KEY = \"goalCheckInState\"") && background.include?("localGet([GOAL_CHECK_STATE_KEY, NUDGE_STATE_KEY])"), "Goal reservations are not isolated from existing nudge state")
assert(background.match?(/async function maybeGoalCheckIn.*?withDataMutation\(async \(\) => \{.*?evaluateGoalCheckIn.*?localSet\(\{ \[GOAL_CHECK_STATE_KEY\]/m), "Goal dedup reservation is not atomic and durable")
assert(background.include?("completeGoalCheckInReservation") && background.include?("failGoalCheckInReservation") && background.match?(/const delivered = await deliverGoalCheckIn.*?withDataMutation.*?delivered\s*\? completeGoalCheckInReservation/m), "Goal state commits before acknowledged delivery or lacks atomic failure release")
assert(background.match?(/const stillAllowed = async.*?repository\.listEvents\(event\.occurredAtMs, nowMs \+ 1\).*?isGoalPlaybackActive\(recentEvents, event, nowMs\)/m), "Goal delivery does not recheck the reserved stream before each delivery stage")
assert(background.match?(/deliveredGoalCheckIn.*?if \(!deliveredGoalCheckIn\) await maybeNudge/m), "Goal and existing nudges can stack on one event")
assert(background.match?(/async function maybeNudge\(event, generation.*?withDataMutation\(async \(\) => \{.*?generation !== historyGeneration.*?currentRevision !== settingsRevision/m), "Existing nudge state mutation lacks serialization/delete/settings guards")
assert(background.include?("const streamEvents = events.filter((item) => playbackStreamKey(item) === streamKey);") && background.include?("activeSessionSeconds(streamEvents, nowMs)"), "Existing nudge context can use the wrong concurrent stream")
assert(background.include?("GOAL_CHECKIN_MIN_GAP_MS") && background.include?("goalLast") && background.include?("lastInterventionAtMs: stored[NUDGE_STATE_KEY]?.emittedAtMs"), "Cross-nudge 60-second gap is not enforced in both directions")
assert(background.match?(/function interventionsAllowed.*?settings\.trackingEnabled === true/m), "Intervention delivery does not recheck tracking consent")
assert(background.scan("generation !== historyGeneration").length >= 10 && background.scan("revision !== settingsRevision").length >= 8, "Delivery/delete/settings race guards regressed")
assert(readme.include?("wording varies by broad context") && readme.include?("once per video identity in 24 hours") && readme.include?("60-second anti-spam gap"), "Goal timing/dedupe/cadence behavior is undocumented")
assert(readme.include?("in-page only") && readme.include?("removes all Chrome/macOS native banners") && readme.include?("sends no out-of-browser alert"), "Native-notification removal/analysis fallback is undocumented")

puts "Chrome integration privacy/restart/delete/notification contract: PASS"
