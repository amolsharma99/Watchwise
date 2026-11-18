#!/usr/bin/env ruby
require "json"
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
nano_source = File.read(File.join(root, "nano-pilot.js"))
jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"

fixture = <<~JAVASCRIPT
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, disabled: false, textContent: "", listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      async click() { return this.listeners.click?.({ currentTarget: this }); }
    });
    return elements.get(id);
  }
  globalThis.self = globalThis;
  globalThis.document = { querySelector(selector) { return element(selector); } };
  globalThis.chrome = { runtime: { getURL(path) { return `chrome-extension://watchwise/${path}`; } } };
  globalThis.fetch = async () => ({ ok: true, async text() { return "00:00 A short public transcript."; } });
  let summarizerAvailabilityCalls = 0, summarizerCreateCalls = 0;
  let languageBaseCalls = 0, languageConfiguredCalls = 0, languageCreateCalls = 0;
  let languageBaseAvailability = "available";
  globalThis.Summarizer = {
    async availability(options) { if (!options?.type) throw new Error("Summarizer options missing"); summarizerAvailabilityCalls += 1; return "available"; },
    async create() { summarizerCreateCalls += 1; throw new Error("create should not run in this fixture"); }
  };
  globalThis.LanguageModel = {
    async availability(options) { if (options === undefined) { languageBaseCalls += 1; return languageBaseAvailability; } languageConfiguredCalls += 1; return "unavailable"; },
    async create() { languageCreateCalls += 1; throw new Error("configured-unavailable create must not run"); }
  };
  function assertNano(value, message) { if (!value) throw new Error(message); }

  element("#summarize").disabled = true;
  element("#assess").disabled = true;

  #{nano_source}

  assertNano(summarizerAvailabilityCalls === 0 && languageBaseCalls === 0 && languageConfiguredCalls === 0, "Nano APIs were probed before user action");
  assertNano(summarizerCreateCalls === 0 && languageCreateCalls === 0, "Nano model was created on page load");
  assertNano(element("#summarize").disabled && element("#assess").disabled, "Nano action buttons must begin disabled");

  await element("#checkAvailability").click();
  assertNano(summarizerAvailabilityCalls === 1, "Summarizer configured availability was not checked once");
  assertNano(languageBaseCalls === 1 && languageConfiguredCalls === 1, "Prompt base and configured availability were not both checked");
  assertNano(!element("#summarize").disabled && element("#assess").disabled, "Configured unavailable Prompt task was enabled");
  assertNano(languageCreateCalls === 0, "Prompt model was created during availability check");

  languageBaseAvailability = "unavailable";
  await element("#checkAvailability").click();
  assertNano(languageBaseCalls === 2 && languageConfiguredCalls === 1, "Unavailable base Prompt API still triggered a configured capability probe");
  assertNano(element("#assess").disabled, "Unavailable base Prompt API enabled assessment");
  languageBaseAvailability = "available";

  await element("#assess").click();
  assertNano(languageConfiguredCalls === 2, "Prompt availability was not rechecked immediately before create");
  assertNano(languageCreateCalls === 0, "Configured unavailable Prompt task called create");
  assertNano(element("#promptStatus").textContent.includes("unavailable on this device/configuration"), "Unavailable Prompt copy is not safe and actionable");
  print("Nano pilot user-initiated capability checks: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-nano-pilot", ".mjs"])
file.write(fixture)
file.flush
stdout = stderr = status = nil
begin
  Open3.popen3(jsc, "-m", file.path) do |stdin, out, err, wait|
    stdin.close
    out_thread = Thread.new { out.read }
    err_thread = Thread.new { err.read }
    begin
      Timeout.timeout(10) { status = wait.value }
    rescue Timeout::Error
      Process.kill("TERM", wait.pid) rescue nil
      raise "Nano pilot JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Nano pilot test did not report PASS" unless stdout.include?("Nano pilot user-initiated capability checks: PASS")
puts "Nano pilot user-initiated capability checks: PASS"
