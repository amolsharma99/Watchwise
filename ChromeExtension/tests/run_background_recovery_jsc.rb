#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
background = File.read(File.join(root, "background.js"))
start = background.index("function eligibleHTTPSContentTab(tab)")
finish = background.index("function frameContext", start || 0)
abort "Could not extract background recovery helpers" unless start && finish
helpers = background[start...finish]

fixture = <<~JAVASCRIPT
  const CONTENT_LIFECYCLE = "watchwise-tracker-v0.3.7";
  let healthReplies = [];
  let sent = [];
  let injections = 0;
  globalThis.URL = class { constructor(value) { this.hostname = String(value).split("/")[2]; } };
  function normalizeHostname(value) { return value; }
  function isExcludedSite() { return false; }
  globalThis.chrome = {
    tabs: { async sendMessage(tabID, message, options) {
      sent.push({ tabID, type: message.type, options });
      if (message.type === "CONTENT_HEALTH_PROBE") return healthReplies.shift();
      if (message.type === "REFRESH_TRACKING_STATE") return { ok: true };
      throw new Error("unexpected message");
    } },
    scripting: { async executeScript() { injections += 1; } }
  };
  function assertRecovery(value, message) { if (!value) throw new Error(message); }
  #{helpers}
  const tab = { id: 7, url: "https://www.youtube.com/watch?v=test" };
  const settings = { trackingEnabled: true, excludedSites: [] };

  healthReplies = [{ ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled: true }];
  sent = []; injections = 0;
  assertRecovery(await recoverContentScriptInTab(tab, settings), "healthy tracker was not accepted");
  assertRecovery(sent.length === 1 && sent[0].type === "CONTENT_HEALTH_PROBE", "healthy tracker was refreshed or injected unnecessarily");
  assertRecovery(injections === 0, "healthy tracker was injected again");

  healthReplies = [
    { ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled: false },
    { ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled: true }
  ];
  sent = []; injections = 0;
  assertRecovery(await recoverContentScriptInTab(tab, settings), "fail-closed tracker was not recovered");
  assertRecovery(sent.map((entry) => entry.type).join(",") === "CONTENT_HEALTH_PROBE,REFRESH_TRACKING_STATE,CONTENT_HEALTH_PROBE", "fail-closed recovery was not exactly probe, one all-frame refresh, re-probe");
  assertRecovery(sent[1].options === undefined, "refresh was restricted to one frame");
  assertRecovery(injections === 0, "live fail-closed tracker was injected instead of refreshed");

  healthReplies = [
    { ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled: false },
    { ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled: false }
  ];
  sent = []; injections = 0;
  const pendingConnection = await activeTabTrackingConnection(tab, settings);
  assertRecovery(pendingConnection.status === "reconnecting", "live fail-closed tracker was mislabeled as reload-required");
  assertRecovery(injections === 0, "live fail-closed status path attempted injection");

  healthReplies = [{ ok: false }];
  sent = []; injections = 0;
  assertRecovery(await recoverContentScriptInTab(tab, settings), "missing tracker was not injected");
  assertRecovery(injections === 1, "missing tracker injection count was not one");
  print("Background content recovery states: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-background-recovery", ".mjs"])
file.write(fixture)
file.flush
stdout = stderr = status = nil
begin
  Open3.popen3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path) do |stdin, out, err, wait|
    stdin.close
    out_thread = Thread.new { out.read }
    err_thread = Thread.new { err.read }
    begin
      Timeout.timeout(10) { status = wait.value }
    rescue Timeout::Error
      Process.kill("TERM", wait.pid) rescue nil
      raise "Background recovery JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Background recovery test did not report PASS" unless stdout.include?("Background content recovery states: PASS")
puts "Background content recovery states: PASS"
