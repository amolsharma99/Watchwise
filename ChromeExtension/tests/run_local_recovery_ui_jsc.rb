#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
source = File.read(File.join(root, "store-local", "sidepanel.js")).sub(/\Aimport[^\n]+\n/, "")

fixture = <<~JAVASCRIPT
  class IndexedDBRepository {
    static instances = [];
    constructor() { this.invalid = false; this.exports = 0; IndexedDBRepository.instances.push(this); }
    async open() { if (this.invalid) throw new Error("stale cached key"); }
    async exportData() { if (this.invalid) throw new Error("stale cached key"); this.exports += 1; return {}; }
  }
  class MockElement {
    constructor(id = "") {
      this.id = id; this.hidden = true; this.textContent = ""; this.value = "";
      this.checked = false; this.disabled = false; this.dataset = {}; this.style = {};
      this.listeners = {};
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    replaceChildren() {}
    append() {}
    appendChild() {}
    click() { this.clicked = true; }
    setAttribute() {}
  }
  const elements = new Map();
  const element = (selector) => {
    const id = String(selector).replace(/^#/, "");
    if (!elements.has(id)) elements.set(id, new MockElement(id));
    return elements.get(id);
  };
  globalThis.document = {
    querySelector: element,
    querySelectorAll() { return []; },
    createElement(tag) { return new MockElement(tag); },
    createTextNode(text) { return { textContent: text }; }
  };
  globalThis.confirm = () => true;
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
  globalThis.URL = class {
    constructor(value) { this.href = String(value); this.protocol = this.href.split(":")[0] + ":"; }
    static createObjectURL() { return "blob:watchwise-export"; }
    static revokeObjectURL() {}
  };
  const sent = [];
  let dashboardAvailable = false;
  globalThis.chrome = {
    runtime: {
      getManifest() { return { version: "0.4.1" }; },
      async sendMessage(message) {
        sent.push(message.type);
        if (message.type === "RESET_SECURE_STORAGE") {
          for (const repository of IndexedDBRepository.instances) repository.invalid = true;
          dashboardAvailable = true;
          return { ok: true };
        }
        if (message.type === "GET_DASHBOARD_STATE" && !dashboardAvailable) return { ok: false, code: "secure_storage_unavailable", error: "Encrypted data unavailable" };
        if (message.type === "GET_DASHBOARD_STATE") return { ok: true, state: {
          extensionVersion: "0.4.1", onboardingComplete: false,
          settings: { trackingEnabled: false, notificationsEnabled: true, excludedSites: [], quietHoursStartMinute: 1320, quietHoursEndMinute: 480, dailyLimitSeconds: 3600 },
          today: { activeSeconds: 0, videosStarted: 0, sites: [], videos: [] },
          week: { activeSeconds: 0, videosStarted: 0, videos: [] }, previousWeekActiveSeconds: 0,
          trackingConnection: { status: "not_applicable", reason: null }
        } };
        throw new Error(`unexpected message ${message.type}`);
      },
      onMessage: { addListener() {} }
    }
  };

  #{source}

  function check(value, message) { if (!value) throw new Error(message); }
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  check(element("#storageRecovery").hidden === false, "secure-storage error did not reveal recovery UI");
  check(element("#onboarding").hidden === true && element("#app").hidden === true, "normal UI remained visible during secure-storage failure");
  const exportData = element("#exportData").listeners.click;
  check(typeof exportData === "function", "export handler was not installed");
  await exportData();
  check(IndexedDBRepository.instances.length === 1 && IndexedDBRepository.instances[0].exports === 1, "pre-reset repository was not primed by export");
  const reset = element("#resetSecureStorage").listeners.click;
  check(typeof reset === "function", "reset handler was not installed");
  await reset();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  check(sent.includes("RESET_SECURE_STORAGE"), "confirmed recovery did not request secure reset");
  check(element("#storageRecovery").hidden === true, "recovery UI remained after reset");
  check(element("#onboarding").hidden === false && element("#app").hidden === true, "post-reset UI did not return to consent-off onboarding");
  await exportData();
  check(IndexedDBRepository.instances.length === 2, "secure reset did not replace the side-panel repository");
  check(IndexedDBRepository.instances[1].exports === 1, "post-reset export did not use the fresh repository/key cache");
  print("Local secure-storage recovery UI: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-local-recovery-ui", ".mjs"])
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
      raise "Local recovery UI JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Local recovery UI test did not report PASS" unless stdout.include?("Local secure-storage recovery UI: PASS")
puts "Local secure-storage recovery UI: PASS"
