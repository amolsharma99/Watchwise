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
auto_analysis = File.read(File.join(root, "lib", "auto-analysis.js"))
gemini_protocol = File.read(File.join(root, "lib", "gemini-protocol.js"))
storage = File.read(File.join(root, "lib", "storage.js"))
readme = File.read(File.join(root, "README.md"))

def assert(condition, message)
  raise message unless condition
end

assert(manifest["manifest_version"] == 3, "Manifest V3 required")
assert(manifest["version"] == "0.3.6", "Netflix title release must use extension version 0.3.6")
assert(manifest["host_permissions"] == ["https://*/*"], "Expected disclosed HTTPS host scope")
assert(manifest["incognito"] == "not_allowed", "Incognito must be disabled")
assert(!manifest.fetch("permissions", []).include?("nativeMessaging"), "Native messaging is forbidden")
assert(manifest.fetch("permissions", []).include?("scripting"), "Existing-tab content recovery requires the scripting permission")
assert(manifest.dig("content_scripts", 0, "all_frames") == true, "All-frame tracking required")

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
assert(background.include?("repository.exportData(await getSettings())"), "Export must use safe settings")
assert(!background.match?(/exportData\([^\n]*(?:API_KEY|geminiApiKey)/), "Export must not receive a key")

assert(background.include?("const settings = await getSettings();\n  if (!settings.aiEnabled) return;"), "Restart must stop when AI consent is disabled")
assert(background.include?("if (action === \"submit\") await submitAnalysis(job, historyGeneration)"), "Restart submit actions are not resumed idempotently")
assert(background.scan("const action = restartAction(job, nowMs);").length == 1, "Each persisted job must have exactly one restart action")
assert(background.match?(/for \(const job .*?\) \{\s*try \{/m), "Restart failures are not isolated per job")
assert(background.include?("type: \"REFRESH_TRACKING_STATE\""), "Settings broadcasts must request per-frame refresh")
assert(content.include?("refreshTrackingState()"), "Frames do not re-request their own tracking state")
assert(content.include?("watchwise-tracker-v0.3.6") && content.include?("__watchwiseContentLifecycle"), "Content lifecycle guard is not revisioned")
assert(content.include?("await previousController.probe()") && content.include?("previousController?.deactivate?.()"), "Stale content instances are not health-checked and deactivated")
assert(content.include?("globalThis[CONTROLLER_KEY] !== startupClaim"), "Repeated recovery lacks an idempotent startup claim")
assert(content.include?("intersectionObserver.disconnect()") && content.include?("mutationObserver.disconnect()") && content.include?("removeListener?.(handleRuntimeMessage)"), "Stale content teardown is incomplete")
deactivate_section = content[/function deactivateLifecycle\(\).*?\n  \}/m]
assert(deactivate_section && deactivate_section.index("stopTracking()") < deactivate_section.index("disposed = true"), "Lifecycle replacement drops the final active interval before stopping")
assert(content.include?("new AbortController()") && content.include?("signal: lifecycleAbortController.signal") && content.include?("lifecycleAbortController.abort()"), "Lifecycle teardown can accumulate anonymous DOM listeners")
assert(content.include?("CONTENT_HEALTH_PROBE") && background.include?("CONTENT_HEALTH_CHECK"), "Content lifecycle health handshake is incomplete")
assert(background.include?("chrome.tabs.query({ url: \"https://*/*\" })"), "Recovery is not restricted to existing HTTPS tabs")
assert(background.include?("target: { tabId: tab.id, allFrames: true }") && background.include?("files: [\"content.js\"]"), "Recovery does not inject the tracker into every eligible frame")
assert(background.include?("target: { tabId: tab.id, frameIds: [0] }"), "Recovery lacks a main-frame fallback when an inaccessible child frame rejects all-frame injection")
assert(background.match?(/async function recoverExistingContentScripts.*?if \(!settings\.trackingEnabled\) return;/m), "Tracking-off state can trigger programmatic content injection")
assert(background.match?(/async function recoverContentScriptInTab.*?if \(await probeContentScript\(tab\.id\)\) return true;.*?injectContentScript/m), "Healthy content instances are not skipped before injection")
assert(background.include?("if (settings.trackingEnabled) void recoverExistingContentScripts(settings);"), "Turning tracking on does not recover stale open tabs")
assert(background.scan("then(recoverExistingContentScripts)").length >= 2, "Recovery does not run during initialization and installation")
assert(background.include?("chrome.runtime.onStartup.addListener") && background.include?("await recoverExistingContentScripts();"), "Startup does not recover existing tabs")
assert(background.include?("chrome.tabs.onActivated.addListener") && background.include?("await recoverContentScriptInTab(tab, settings)"), "Activated tabs are not consent-gated, probed and recovered")
assert(background.match?(/CONTENT_READY.*?sender\.frameId === 0.*?announceDashboardUpdated/m), "A recovered top frame does not settle the side-panel connection state")
assert(background.include?("trackingConnection: await activeTabTrackingConnection(activeTab, settings)"), "Dashboard lacks active-tab tracker health")
assert(sidepanel_js.include?("Tracker connected") && sidepanel_js.include?("Tracking on · reconnecting") && sidepanel_js.include?("Tracking on · reload video tab"), "Tracking pill lacks recovery states")
assert(sidepanel_js.include?("Tracking off here · excluded"), "Tracking pill can imply that global consent overrides a site exclusion")
assert(background.include?("historyGeneration += 1"), "Delete generation guard missing")
assert(background.include?("generation !== historyGeneration"), "Late job write guard missing")
delete_section = background[/case "DELETE_HISTORY": \{.*?return \{ ok: true \};\s*\}/m]
assert(delete_section&.include?("withDataMutation(async () => {"), "Delete is not serialized with job writes")
assert(delete_section&.include?("sessions.clear();"), "Delete does not clear in-memory playback sessions")
assert(delete_section&.include?("await repository.deleteAll();"), "Delete does not clear IndexedDB inside the mutation queue")
assert(delete_section&.include?("await localSet({ [ANALYSIS_SOURCES_KEY]: {}, [NUDGE_STATE_KEY]: {} });"), "Delete does not serialize source/nudge metadata clearing")
assert(delete_section&.include?("await announceDashboardUpdated({ immediate: true });"), "Delete does not immediately refresh open dashboards")
assert(background.match?(/const event = await withDataMutation\(async \(\) => \{.*?const sessionID = await resolveSessionID.*?repository\.putEvent\(validated\)/m), "Session resolution and event persistence are not serialized with deletion")
assert(background.match?(/async function ingestPlayback.*?const generation = historyGeneration;.*?const settings = await getSettings\(\);.*?const revision = settingsRevision;.*?const event = await withDataMutation\(async \(\) => \{\s*if \(generation !== historyGeneration \|\| revision !== settingsRevision\) return null;\s*const sessionID = await resolveSessionID.*?if \(!event\) return \{ accepted: false \};/m), "In-flight playback can persist after deletion or a privacy-settings revision")
assert(background.match?(/const sessionID = await resolveSessionID.*?if \(generation !== historyGeneration \|\| revision !== settingsRevision\) \{\s*sessions\.clear\(\);\s*return null;\s*\}.*?const validated = validatePlaybackEvent/m), "Playback does not re-check privacy state after asynchronous session resolution")
assert(background.include?("const sourceStored = await withDataMutation(async () => {"), "Analysis source persistence is not serialized with deletion")
assert(background.match?(/sourceStored.*?generation !== historyGeneration.*?repository\.getAnalysisJob.*?localGet\(ANALYSIS_SOURCES_KEY\).*?generation !== historyGeneration.*?repository\.getAnalysisJob.*?localSet/m), "Source metadata lacks generation/job checks inside its mutation")

assert(gemini_protocol.include?("step.type !== \"model_output\""), "Provider output extraction is not restricted to model_output steps")
assert(!gemini_protocol.include?("for (const child of Object.values(value))"), "Provider output still recursively scans user/thought text")
assert(gemini_protocol.match?(/input:\s*\[\s*\{ type: \"video\".*?\},\s*\{ type: \"text\"/m), "Gemini request must place the video before the text prompt")
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

assert(background.include?("message: \"Open Watchwise to view the private summary.\""), "Completion notification leaks or lacks private wording")
assert(!background.match?(/message:\s*`[^`]*result\.(?:summary|verdict)/), "Lock-screen notification includes analysis content")
assert(background.include?("interventionsAllowed(settings, nowMs)"), "Completion suppression gate missing")
assert(background.include?("interventionsAllowed(currentSettings, Date.now(), event.pageSite)"), "Nudge suppression re-check missing")
assert(background.include?("clearInterventions()"), "Suppression must clear pending notifications/toasts")

assert(panel.include?("safe settings—never the API key"), "Export disclosure is inaccurate")
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
assert(auto_analysis.include?("export function isUnidentifiedYouTubeURL"), "Shared unidentified-YouTube policy helper is missing")
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
assert(readme.include?("Updating the unpacked build to v0.3.6") && readme.include?("header reads **v0.3.6**"), "Reload-unpacked/version verification guidance is missing")
assert(readme.include?("restores tracking in eligible HTTPS tabs") && readme.include?("v0.3.4 local Chrome AI trial remains unchanged"), "Existing-tab recovery or Nano preservation is undocumented")
assert(readme.include?("Safe Gemini live test") && readme.include?("https://www.youtube.com/watch?v=9hE5-98ZeCg") && readme.include?("never share the API key"), "Controlled one-request Gemini test guidance is missing")
assert(readme.include?("homepage/feed playback without a canonical video ID is rejected before local persistence"), "Anonymous YouTube preview persistence policy is undocumented")
assert(insights.include?("youtubeVideoIdentity(event.url)"), "Video breakdown does not use shared YouTube identity")
assert(insights.include?("shareSeconds = (nextTime - time) / 1000 / activeVideoCounts.size"), "Overlapping video attribution is not split overlap-safely")
assert(sidepanel_js.include?("url.protocol === \"https:\""), "Video breakdown links are not HTTPS-gated")
assert(sidepanel_js.include?("link.rel = \"noopener noreferrer\""), "Video breakdown links lack safe opener isolation")
assert(panel.include?("rows add up to the overall total"), "Per-video overlap semantics are not disclosed")

puts "Chrome integration privacy/restart/delete/notification contract: PASS"
