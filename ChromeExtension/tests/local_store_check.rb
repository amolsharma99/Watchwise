#!/usr/bin/env ruby
require "json"
require "open3"
require "tmpdir"

root = File.expand_path("..", __dir__)
packager = File.join(root, "scripts", "package_local_store.rb")

def assert(value, message)
  raise message unless value
end

Dir.mktmpdir("watchwise-local-check") do |stage|
  production = File.join(stage, "production")
  stdout, stderr, status = Open3.capture3("ruby", packager, "--stage", production)
  raise [stdout, stderr].join("\n") unless status.success?
  stage = production

  manifest = JSON.parse(File.read(File.join(stage, "manifest.json")))
  assert(manifest["version"] == "0.4.3", "wrong local Store version")
  assert(manifest["permissions"] == %w[scripting sidePanel], "local permissions are not minimal")
  assert(!manifest.fetch("permissions", []).include?("alarms"), "alarm permission leaked")
  assert(manifest["host_permissions"] == ["https://*/*"], "wrong host scope")
  assert(manifest.fetch("content_scripts").none? { |entry| entry.fetch("js").any? { |path| path.include?("studio") } }, "Studio handoff script remains installed")

  files = Dir.chdir(stage) { Dir.glob("**/*", File::FNM_DOTMATCH).select { |path| File.file?(path) }.sort }
  forbidden_files = %w[lib/analysis.js lib/auto-analysis.js lib/gemini-protocol.js lib/index.js nano-pilot.html nano-sample.txt]
  assert((files & forbidden_files).empty?, "model feature modules leaked into local package")
  assert(!files.include?("studio-handoff.js") && !files.include?("studio-prefill.js"), "Studio handoff leaked into package")
  source = files.grep(/\.(?:js|json|html|css|txt)\z/).map { |path| File.read(File.join(stage, path)) }.join("\n")
  {
    "remote provider" => /gemini|generativelanguage/i,
    "credential access" => /api.?key|apiKeyConfigured/i,
    "network call" => /\bfetch\s*\(/,
    "alternate network API" => /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|navigator\.sendBeacon/,
    "model settings" => /aiEnabled|autoAnalysisEnabled|ANALYZE_URL/,
    "model stores" => /analysis(?:Jobs|Results|Sources)/i,
    "alarm API" => /chrome\.alarms|["']alarms["']/,
    "storage API" => /chrome\.storage/,
    "seek capability" => /SEEK_PLAYER|SEEK_TIMESTAMP|suggestedTimestampSeconds/
  }.each { |label, pattern| assert(!source.match?(pattern), "#{label} leaked into local package") }

  panel = File.read(File.join(stage, "sidepanel.html"))
  background = File.read(File.join(stage, "background.js"))
  sidepanel = File.read(File.join(stage, "sidepanel.js"))
  storage = File.read(File.join(stage, "lib", "storage.js"))
  settings = File.read(File.join(stage, "lib", "settings.js"))
  assert(panel.scan(/data-panel=/).length == 2 && panel.include?('data-panel="overview"') && panel.include?('data-panel="settings"'), "public UI is not Overview + Settings only")
  assert(panel.include?('src="assets/icon32.png"') && !panel.include?('>W</span>'), "selected eye/play mark is missing from panel")
  assert(!background.include?("OPEN_AI_STUDIO") && !background.include?("aistudio.google.com"), "Studio handoff handler remains")
  assert(panel.include?('id="storageRecovery"') && panel.include?('id="resetSecureStorage"') && panel.include?("permanently deletes all Watchwise viewing history and settings"), "destructive secure-storage recovery UI is missing")
  %w[videoBreakdown movieMode snooze quietEnabled exclusionForm exportData deleteData].each { |id| assert(panel.include?("id=\"#{id}\""), "missing local feature #{id}") }
  assert(background.include?('CONTENT_LIFECYCLE = "watchwise-tracker-v0.3.9"'), "local update would reject healthy shared tracker")
  assert(background.include?("recoverExistingContentScripts") && background.include?("recoverContentScriptInTab"), "content recovery missing")
  assert(background.include?("maybeGoalCheckIn") && background.include?("maybeNudge"), "local interventions missing")
  assert(background.include?('message.action?.type === "exclude_current_site"') && background.include?("excludeCurrentSiteFromToast(sender)"), "work exclusion action is not routed")
  assert(File.read(File.join(stage, "content.js")).include?("This is work"), "work exclusion button is missing from the public toast")
  assert(background.include?("maybePrune") && !background.include?("onAlarm"), "retention is not initialization/opportunistic only")
  assert(background.include?("try { await maybePrune(Date.now()); } catch {}") && background.include?("void maybePrune().catch(() => {});"), "corrupt history can block initialization or later ingestion")
  assert(background.match?(/case "DELETE_HISTORY".*?repository\.deleteAll\(\).*?\[NUDGE_STATE_KEY\]: \{\}, \[GOAL_CHECK_STATE_KEY\]: \{\}/m), "corruption-tolerant delete does not clear event/intervention history")
  assert(background.include?('code: "secure_storage_unavailable"') && background.include?('message?.type === "RESET_SECURE_STORAGE"') && background.match?(/RESET_SECURE_STORAGE.*?!isExtensionPage\(sender\).*?resetSecureStorage\(\)/m), "authenticated secure-storage recovery message contract is missing")
  assert(storage.include?("async resetSecureStorage()") && storage.match?(/resetSecureStorage\(\).*?objectStore\(RECORD_STORE\)\.clear\(\).*?objectStore\(KEY_STORE\)\.clear\(\).*?this\.#key\(\).*?this\.setState\(defaultState\(\)\)/m), "repository secure reset does not rotate key and restore encrypted defaults")
  assert(background.match?(/async function completeOnboarding.*?withDataMutation\(async \(\) => \{.*?repository\.getState\(\).*?repository\.setState\(\{ \.\.\.state, settings, onboardingComplete: true \}\)/m), "onboarding and settings are not one serialized encrypted-state update")
  export_click = sidepanel.index("link.click()")
  export_revoke = sidepanel.index("URL.revokeObjectURL(url)")
  assert(export_click && export_revoke && export_click < export_revoke && sidepanel.include?("setTimeout(() => URL.revokeObjectURL(url), 1_000)"), "plaintext export URL is revoked before its explicit download starts")
  assert(sidepanel.include?("Export decrypted viewing history as plaintext JSON?") && sidepanel.include?("Plaintext JSON exported. Store it safely."), "plaintext export warning or confirmation is missing")
  assert(sidepanel.include?('error.code = response?.code') && sidepanel.include?('error.code === "secure_storage_unavailable"') && sidepanel.include?('send("RESET_SECURE_STORAGE")'), "recovery code is not wired to the side-panel reset action")
  assert(storage.include?('DATABASE_NAME = "watchwise-local"') && storage.include?("DATABASE_VERSION = 1"), "local database is not isolated and clean")
  assert(storage.include?('name: "AES-GCM", length: 256') && storage.include?('false, ["encrypt", "decrypt"]'), "AES-256-GCM non-extractable key contract missing")
  assert(storage.include?('createIndex("byIV", "iv", { unique: true })'), "IV uniqueness constraint missing")
  assert(storage.include?("additionalData") && !storage.include?("exportKey("), "authenticated envelope or non-exportable-key boundary missing")
  assert(!storage.include?("deleteObjectStore"), "public edition contains hidden legacy-store migration")
  assert(!settings.include?("aiEnabled") && !settings.include?("autoAnalysisEnabled"), "local settings retain model fields")
end

puts "Local Store static/privacy contract: PASS"
