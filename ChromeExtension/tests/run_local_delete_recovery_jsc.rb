#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
background = File.read(File.join(root, "store-local", "background.js"))
body_start = background.index("const SETTINGS_KEY")
abort "Could not locate local background body" unless body_start
body = background[body_start..]

fixture = <<~JAVASCRIPT
  let messageListener;
  const initialSettings = {
    trackingEnabled: true,
    notificationsEnabled: true,
    excludedSites: ["private.example"],
    dailyLimitSeconds: 1800,
    longSessionSeconds: 1200
  };
  class SecureStorageError extends Error { constructor(message) { super(message); this.code = "secure_storage_unavailable"; } }
  function isSecureStorageError(error) { return error?.code === "secure_storage_unavailable"; }
  class IndexedDBRepository {
    constructor() {
      this.state = {
        settings: { ...initialSettings },
        onboardingComplete: true,
        nudgeState: { emittedAtMs: [123] },
        goalCheckInState: { processed: [{ identity: "youtube:private" }] }
      };
      this.events = [{ ciphertext: "corrupt" }];
      globalThis.testRepository = this;
    }
    async open() {}
    async getState() { return JSON.parse(JSON.stringify(this.state)); }
    async setState(value) { this.state = JSON.parse(JSON.stringify(value)); }
    async prune() { throw new SecureStorageError("authenticated history is corrupt"); }
    async resetSecureStorage() {
      this.events = [];
      this.state = { settings: {}, onboardingComplete: false, nudgeState: {}, goalCheckInState: {}, maintenance: { lastPruneAtMs: 0 } };
      this.reset = true;
    }
    async deleteAll() { this.events = []; }
    async listEvents() { if (!this.reset) throw new SecureStorageError("authenticated history is corrupt"); return []; }
  }
  function normalizeSettings(value = {}) { return { trackingEnabled: false, notificationsEnabled: true, excludedSites: [], ...value }; }
  function normalizeHostname(value) { return String(value); }
  function isExcludedSite() { return false; }
  function isQuietTime() { return false; }
  function playbackStreamKey() { return "stream"; }
  function validatePlaybackEvent(value) { return value; }
  function isUnidentifiedYouTubeURL() { return false; }
  function dayWindow() { return { startMs: 0, endMs: 1 }; }
  function weekWindow() { return { startMs: 0, endMs: 1 }; }
  function summarizeViewing() { return { activeSeconds: 0, contentSeconds: 0, videosStarted: 0, sites: [], videos: [] }; }
  function activeSessionSeconds() { return 0; }
  function distinctSessionsInWindow() { return 0; }
  function evaluateGoalCheckIn() { return null; }
  function completeGoalCheckInReservation(value) { return value; }
  function failGoalCheckInReservation(value) { return value; }
  function deliverGoalCheckIn() { return false; }
  function isGoalPlaybackActive() { return false; }
  const GOAL_CHECKIN_MIN_GAP_MS = 60_000;
  class NudgeEngine {}

  globalThis.chrome = {
    runtime: {
      id: "watchwise-local-test",
      getURL(path = "") { return `chrome-extension://watchwise-local-test/${path}`; },
      getManifest() { return { version: "0.4.1" }; },
      sendMessage() { return Promise.resolve(); },
      onMessage: { addListener(listener) { messageListener = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    tabs: {
      query() { return Promise.resolve([]); },
      sendMessage() { return Promise.resolve({ ok: false }); },
      get() { return Promise.resolve(null); },
      onActivated: { addListener() {} }
    },
    scripting: { executeScript() { return Promise.resolve(); } },
    sidePanel: { setPanelBehavior() { return Promise.resolve(); }, open() { return Promise.resolve(); } },
    windows: { getLastFocused() { return Promise.resolve({ id: 1 }); }, get() { return Promise.resolve({ focused: true }); } }
  };

  #{body}

  function assertDelete(value, message) { if (!value) throw new Error(message); }
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("sidepanel.html") };
  const request = (message) => new Promise((resolve, reject) => {
    const keptOpen = messageListener(message, sender, resolve);
    if (keptOpen !== true) reject(new Error("message channel was not kept open"));
  });
  const unavailable = await request({ type: "GET_DASHBOARD_STATE" });
  assertDelete(unavailable?.ok === false && unavailable.code === "secure_storage_unavailable", "corrupt dashboard did not return safe recovery code");
  const reset = await request({ type: "RESET_SECURE_STORAGE" });
  assertDelete(reset?.ok === true, `secure reset failed: ${JSON.stringify(reset)}`);
  const recovered = await request({ type: "GET_DASHBOARD_STATE" });
  assertDelete(recovered?.ok === true && recovered.state?.settings?.trackingEnabled !== true && recovered.state?.onboardingComplete === false, "dashboard did not recover to consent-off defaults");

  testRepository.events = [{ ciphertext: "corrupt" }];
  testRepository.state = {
    settings: { ...initialSettings }, onboardingComplete: true,
    nudgeState: { emittedAtMs: [123] }, goalCheckInState: { processed: [{ identity: "youtube:private" }] }
  };
  const response = await new Promise((resolve, reject) => {
    const keptOpen = messageListener(
      { type: "DELETE_HISTORY" },
      sender,
      resolve
    );
    if (keptOpen !== true) reject(new Error("message channel was not kept open"));
  });
  assertDelete(response?.ok === true, `delete response failed: ${JSON.stringify(response)}`);
  assertDelete(testRepository.events.length === 0, "corrupt event history was not deleted");
  assertDelete(Object.keys(testRepository.state.nudgeState || {}).length === 0, "nudge state was not cleared");
  assertDelete(Object.keys(testRepository.state.goalCheckInState || {}).length === 0, "goal state was not cleared");
  assertDelete(testRepository.state.settings.trackingEnabled === true, "readable tracking setting was lost");
  assertDelete(testRepository.state.settings.excludedSites[0] === "private.example", "readable exclusions were lost");
  assertDelete(testRepository.state.onboardingComplete === true, "onboarding state was lost");
  print("Local corrupt-startup delete recovery: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-local-delete-recovery", ".mjs"])
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
      raise "Local delete recovery JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Local delete recovery test did not report PASS" unless stdout.include?("Local corrupt-startup delete recovery: PASS")
puts "Local corrupt-startup delete recovery: PASS"
