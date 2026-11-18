#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "tmpdir"
require "timeout"

root = File.expand_path("..", __dir__)
packager = File.join(root, "scripts", "package_local_store.rb")

Dir.mktmpdir("watchwise-local-dynamic") do |stage|
  production = File.join(stage, "production")
  stdout, stderr, status = Open3.capture3("ruby", packager, "--stage", production)
  abort [stdout, stderr].join("\n") unless status.success?
  stage = production

  fixture = <<~JAVASCRIPT
    import { normalizeSettings } from "./lib/settings.js";
    import { NudgeEngine } from "./lib/nudges.js";
    import { youtubeVideoIdentity } from "./lib/youtube.js";
    function check(value, message) { if (!value) throw new Error(message); }

    const sanitized = normalizeSettings({
      trackingEnabled: true,
      notificationsEnabled: true,
      excludedSites: ["Example.COM"],
      movieModeUntilMs: 5000,
      snoozedUntilMs: 6000,
      quietHoursEnabled: true,
      quietHoursStartMinute: 1200,
      quietHoursEndMinute: 480,
      dailyLimitSeconds: 1800,
      longSessionSeconds: 900,
      aiEnabled: true,
      autoAnalysisEnabled: true
    });
    check(sanitized.trackingEnabled && sanitized.notificationsEnabled, "tracking/alert preferences were not retained");
    check(sanitized.excludedSites[0] === "example.com" && sanitized.quietHoursEnabled, "privacy/interruption preferences were not retained");
    check(!Object.hasOwn(sanitized, "aiEnabled") && !Object.hasOwn(sanitized, "autoAnalysisEnabled"), "model settings survived local normalization");
    const now = 1000000;
    const engine = new NudgeEngine({ cooldownMs: 0, hourlyLimit: 3 });
    const activeSettings = { ...sanitized, quietHoursEnabled: false, movieModeUntilMs: null, snoozedUntilMs: null };
    const decision = engine.evaluate({ nowMs: now, pageSite: "video.example", dailyActiveSeconds: 1900, activeSessionSeconds: 0, distinctSessionsLast20Minutes: 1 }, activeSettings, 0);
    check(decision.nudge?.kind === "daily_limit", "local daily nudge missing");
    const silenced = new NudgeEngine().evaluate({ nowMs: now, pageSite: "video.example", dailyActiveSeconds: 9999, activeSessionSeconds: 0, distinctSessionsLast20Minutes: 1 }, { ...activeSettings, notificationsEnabled: false }, 0);
    check(silenced.nudge === null && silenced.suppression === "notifications_off", "local alert suppression failed");
    check(youtubeVideoIdentity("https://www.youtube.com/shorts/abc")?.videoKey === "youtube:abc", "shared YouTube identity missing");
    print("Local Store dynamic settings/schema/nudge contract: PASS");
  JAVASCRIPT

  file = Tempfile.new(["local-contract", ".mjs"], stage)
  file.write(fixture)
  file.flush
  output = error = nil
  result = nil
  begin
    Open3.popen3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path) do |stdin, out, err, wait|
      stdin.close
      out_thread = Thread.new { out.read }
      err_thread = Thread.new { err.read }
      Timeout.timeout(10) { result = wait.value }
      output = out_thread.value
      error = err_thread.value
    end
  rescue Timeout::Error
    abort "Local Store dynamic JSC test timed out"
  ensure
    file.close!
  end
  abort [output, error].join("\n") unless result&.success? && output.include?("Local Store dynamic settings/schema/nudge contract: PASS")
end

puts "Local Store dynamic settings/schema/nudge contract: PASS"
