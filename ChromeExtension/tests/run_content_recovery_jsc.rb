#!/usr/bin/env ruby
require "json"
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
content_source = File.read(File.join(root, "content.js"))
jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"

fixture = <<~JAVASCRIPT
  const CONTENT_SOURCE = #{JSON.generate(content_source)};
  let healthIsCurrent = true;
  let observerCreates = 0, observerDisconnects = 0;
  let mutationCreates = 0, mutationDisconnects = 0;
  let runtimeAdds = 0, runtimeRemoves = 0;
  const messages = [];
  function assertRecovery(value, message) { if (!value) throw new Error(message); }

  class MockSearchParams {
    constructor(query = "") { this.values = new Map(); for (const pair of query.replace(/^\\?/, "").split("&")) { if (!pair) continue; const [key, value = ""] = pair.split("=", 2); this.values.set(decodeURIComponent(key), decodeURIComponent(value)); } }
    get(key) { return this.values.has(key) ? this.values.get(key) : null; }
    set(key, value) { this.values.set(String(key), String(value)); }
    toString() { return [...this.values].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&"); }
  }
  globalThis.URL = class {
    constructor(input) {
      const match = /^(https:)?\\/\\/([^/?#]+)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(String(input));
      if (!match) throw new Error("invalid mock URL");
      this.protocol = match[1] || "https:"; this.hostname = match[2]; this.pathname = match[3] || "/";
      this.username = ""; this.password = ""; this.hash = match[5] || ""; this.searchParams = new MockSearchParams(match[4] || "");
    }
    get search() { const value = this.searchParams.toString(); return value ? `?${value}` : ""; }
    set search(value) { this.searchParams = new MockSearchParams(value); }
    toString() { return `${this.protocol}//${this.hostname}${this.pathname}${this.search}${this.hash}`; }
  };
  globalThis.AbortController = class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } };
  class Element { querySelectorAll() { return []; } }
  class HTMLVideoElement extends Element {}
  globalThis.Element = Element; globalThis.HTMLVideoElement = HTMLVideoElement; globalThis.innerHeight = 900;
  globalThis.location = { href: "https://www.youtube.com/watch?v=first", hostname: "www.youtube.com", pathname: "/watch" };
  globalThis.document = {
    title: "YouTube", visibilityState: "visible", documentElement: new Element(),
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, removeEventListener() {}
  };
  globalThis.IntersectionObserver = class { constructor() { observerCreates += 1; } observe() {} unobserve() {} disconnect() { observerDisconnects += 1; } };
  globalThis.MutationObserver = class { constructor() { mutationCreates += 1; } observe() {} disconnect() { mutationDisconnects += 1; } };
  globalThis.chrome = { runtime: {
    sendMessage(message) {
      messages.push(message);
      if (message.type === "CONTENT_HEALTH_CHECK") return Promise.resolve({ ok: healthIsCurrent, lifecycle: "watchwise-tracker-v0.3.6" });
      if (message.type === "CONTENT_READY") return Promise.resolve({ ok: true, enabled: false });
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener() { runtimeAdds += 1; }, removeListener() { runtimeRemoves += 1; } }
  }};

  delete globalThis.__watchwiseContentLifecycle;
  await eval(CONTENT_SOURCE);
  const first = globalThis.__watchwiseContentLifecycle;
  assertRecovery(first?.lifecycle === "watchwise-tracker-v0.3.6", "missing injection did not create a controller");
  assertRecovery(observerCreates === 1 && mutationCreates === 1 && runtimeAdds === 1, "missing injection duplicated resources");

  await eval(CONTENT_SOURCE);
  assertRecovery(globalThis.__watchwiseContentLifecycle === first, "healthy recovery replaced the live controller");
  assertRecovery(observerCreates === 1 && mutationCreates === 1 && runtimeAdds === 1, "healthy recovery duplicated resources");

  healthIsCurrent = false;
  await eval(CONTENT_SOURCE);
  const replacement = globalThis.__watchwiseContentLifecycle;
  assertRecovery(replacement !== first && first.isDisposed(), "stale controller was not deactivated and replaced");
  assertRecovery(observerDisconnects === 1 && mutationDisconnects === 1 && runtimeRemoves === 1, "stale controller cleanup was incomplete");

  healthIsCurrent = true;
  await eval(CONTENT_SOURCE);
  assertRecovery(globalThis.__watchwiseContentLifecycle === replacement, "repeated recovery after replacement was not idempotent");

  location.href = "https://www.youtube.com/shorts/second"; location.pathname = "/shorts/second";
  await replacement.refresh();
  const ready = messages.filter((message) => message.type === "CONTENT_READY").at(-1);
  assertRecovery(ready?.url === "https://www.youtube.com/shorts/second", "recovered tracker missed the SPA URL change");
  print("Content recovery lifecycle: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-content-recovery", ".mjs"])
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
      raise "Content recovery JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Content recovery test did not report PASS" unless stdout.include?("Content recovery lifecycle: PASS")
puts "Content recovery lifecycle: PASS"
