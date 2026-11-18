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
  let runtimeListener = null;
  let sendMode = "normal";
  let readyEnabled = false;
  const readyReplyQueue = [];
  let nextTimeoutID = 1;
  const pendingTimeouts = new Map();
  let nextIntervalID = 1;
  const pendingIntervals = new Map();
  let latestIntersectionObserver = null;
  let videosInDocument = [];
  const createdElements = [];
  const messages = [];
  function assertRecovery(value, message) { if (!value) throw new Error(message); }
  function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

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
  globalThis.setTimeout = (callback, delay) => { const id = nextTimeoutID++; pendingTimeouts.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = (id) => { pendingTimeouts.delete(id); };
  class Element {
    constructor(tag = "div") { this.tag = tag; this.style = {}; this.listeners = {}; this.children = []; this.id = ""; this.className = ""; this.textContent = ""; }
    querySelectorAll() { return []; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    append(...nodes) { this.children.push(...nodes); }
    attachShadow() { return new Element("shadow"); }
    setAttribute() {}
    remove() { this.removed = true; }
  }
  class HTMLVideoElement extends Element {
    constructor() {
      super("video"); this.currentSrc = "https://cdn.example/video.mp4"; this.src = this.currentSrc;
      this.duration = 60; this.currentTime = 4; this.playbackRate = 1; this.paused = false; this.ended = false; this.isConnected = true;
    }
    getAttribute() { return null; }
    focus() {}
  }
  class HTMLIFrameElement extends Element {}
  globalThis.Element = Element; globalThis.HTMLVideoElement = HTMLVideoElement; globalThis.HTMLIFrameElement = HTMLIFrameElement; globalThis.innerHeight = 900;
  globalThis.location = { href: "https://www.youtube.com/watch?v=first", hostname: "www.youtube.com", pathname: "/watch" };
  globalThis.navigator = { mediaSession: { metadata: null } };
  globalThis.document = {
    title: "YouTube", visibilityState: "visible", documentElement: new Element(),
    querySelectorAll(selector) { return selector === "video" ? videosInDocument : []; }, querySelector(selector) { return selector === "#watchwise-toast-host" ? createdElements.find((node) => node.id === "watchwise-toast-host" && !node.removed) || null : null; },
    createElement(tag) { const node = new Element(tag); createdElements.push(node); return node; },
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.IntersectionObserver = class { constructor(callback) { observerCreates += 1; this.callback = callback; latestIntersectionObserver = this; } observe() {} unobserve() {} disconnect() { observerDisconnects += 1; } };
  globalThis.MutationObserver = class { constructor() { mutationCreates += 1; } observe() {} disconnect() { mutationDisconnects += 1; } };
  globalThis.setInterval = (callback, delay) => { const id = nextIntervalID++; pendingIntervals.set(id, { callback, delay }); return id; };
  globalThis.clearInterval = (id) => { pendingIntervals.delete(id); };
  globalThis.chrome = { runtime: {
    id: "watchwise-test",
    sendMessage(message) {
      messages.push(message);
      if (sendMode === "throw_invalidated") throw new Error("Extension context invalidated.");
      if (sendMode === "reject_invalidated") return Promise.reject(new Error("Extension context invalidated."));
      if (sendMode === "reject_transient") return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      if (message.type === "CONTENT_HEALTH_CHECK") return Promise.resolve({ ok: healthIsCurrent, lifecycle: "watchwise-tracker-v0.3.9" });
      if (message.type === "CONTENT_READY") return readyReplyQueue.length ? readyReplyQueue.shift() : Promise.resolve({ ok: true, enabled: readyEnabled });
      return Promise.resolve({ ok: true });
    },
    onMessage: {
      addListener(listener) { runtimeAdds += 1; runtimeListener = listener; },
      removeListener(listener) { runtimeRemoves += 1; if (runtimeListener === listener) runtimeListener = null; }
    }
  }};

  delete globalThis.__watchwiseContentLifecycle;
  await eval(CONTENT_SOURCE);
  const first = globalThis.__watchwiseContentLifecycle;
  assertRecovery(first?.lifecycle === "watchwise-tracker-v0.3.9", "missing injection did not create a controller");
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

  readyEnabled = true;
  const activeVideo = new HTMLVideoElement();
  videosInDocument = [activeVideo];
  await replacement.refresh();
  assertRecovery(replacement.isTrackingEnabled(), "fixture could not enable local tracking");
  latestIntersectionObserver.callback([{ target: activeVideo, isIntersecting: true, intersectionRatio: 1, intersectionRect: { width: 640, height: 360 } }]);
  assertRecovery(messages.some((message) => message.type === "PLAYBACK_EVENT"), "fixture could not establish active playback");
  messages.length = 0;
  sendMode = "reject_transient";
  await replacement.refresh();
  assertRecovery(!replacement.isDisposed(), "a transient receiving-end failure permanently stopped tracking");
  assertRecovery(!replacement.isTrackingEnabled(), "a failed refresh did not fail closed locally");
  assertRecovery(!messages.some((message) => message.type === "PLAYBACK_EVENT"), "failed/off refresh cleanup attempted post-consent playback telemetry");
  const retry = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === 1_000);
  assertRecovery(retry, "a failed refresh did not schedule its bounded retry");
  sendMode = "normal";
  pendingTimeouts.delete(retry[0]);
  retry[1].callback();
  await Promise.resolve(); await Promise.resolve();
  assertRecovery(replacement.isTrackingEnabled(), "the bounded retry did not restore tracking from a valid response");

  const olderEnabled = deferred();
  readyReplyQueue.push(olderEnabled.promise, Promise.resolve({ ok: true, enabled: false }));
  const olderRefresh = replacement.refresh();
  await replacement.refresh();
  olderEnabled.resolve({ ok: true, enabled: true });
  await olderRefresh;
  assertRecovery(!replacement.isTrackingEnabled(), "an older enabled response overrode a newer disabled response");

  readyEnabled = true;
  await replacement.refresh();
  const staleEnabled = deferred();
  readyReplyQueue.push(staleEnabled.promise);
  const staleRefresh = replacement.refresh();
  runtimeListener({ type: "TRACKING_STATE", enabled: false }, {}, () => {});
  staleEnabled.resolve({ ok: true, enabled: true });
  await staleRefresh;
  assertRecovery(!replacement.isTrackingEnabled(), "an older enabled response overrode a direct off command");
  assertRecovery(![...pendingTimeouts.values()].some((timer) => [1_000, 2_000, 4_000].includes(timer.delay)), "direct off retained a refresh retry");

  readyReplyQueue.push(Promise.resolve({ ok: false, enabled: true }));
  await replacement.refresh();
  assertRecovery(!replacement.isTrackingEnabled(), "a non-ok CONTENT_READY response enabled tracking");
  assertRecovery([...pendingTimeouts.values()].some((timer) => timer.delay === 1_000), "a non-ok response did not enter bounded retry");
  readyEnabled = false;
  await replacement.refresh();

  sendMode = "reject_transient";
  await replacement.refresh();
  for (const expectedDelay of [1_000, 2_000, 4_000]) {
    const scheduled = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === expectedDelay);
    assertRecovery(scheduled, `bounded retry ${expectedDelay}ms was not scheduled`);
    pendingTimeouts.delete(scheduled[0]);
    scheduled[1].callback();
    await Promise.resolve(); await Promise.resolve();
  }
  assertRecovery(![...pendingTimeouts.values()].some((timer) => [1_000, 2_000, 4_000].includes(timer.delay)), "refresh retries continued after the three-attempt cap");
  assertRecovery(!replacement.isTrackingEnabled(), "exhausted refresh retries did not remain fail closed");

  sendMode = "normal";
  readyEnabled = true;
  let offHealth = null;
  runtimeListener({ type: "CONTENT_HEALTH_PROBE" }, {}, (response) => { offHealth = response; });
  assertRecovery(offHealth?.trackingEnabled === false, "health probe did not expose fail-closed local state");
  let refreshResponse = null;
  const keptOpen = runtimeListener({ type: "REFRESH_TRACKING_STATE" }, {}, (response) => { refreshResponse = response; });
  assertRecovery(keptOpen === true, "refresh message did not keep the response channel open");
  for (let index = 0; index < 10 && refreshResponse === null; index += 1) await Promise.resolve();
  assertRecovery(refreshResponse?.ok === true && replacement.isTrackingEnabled(), "one recovery refresh did not restore fail-closed tracking");
  const throwingResponseKeptOpen = runtimeListener({ type: "REFRESH_TRACKING_STATE" }, {}, () => { throw new Error("invalidated response port"); });
  assertRecovery(throwingResponseKeptOpen === true, "throwing response-port fixture did not keep its channel open");
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  assertRecovery(!replacement.isDisposed(), "a throwing response port caused disposal recursion or an unhandled rejection");
  let enabledHealth = null;
  runtimeListener({ type: "CONTENT_HEALTH_PROBE" }, {}, (response) => { enabledHealth = response; });
  assertRecovery(enabledHealth?.trackingEnabled === true, "health probe did not expose restored local state");

  sendMode = "throw_invalidated";
  await replacement.refresh();
  assertRecovery(replacement.isDisposed(), "a synchronous invalidated-context failure did not self-dispose");
  assertRecovery(![...pendingTimeouts.values()].some((timer) => timer.delay === 1_000), "an invalidated tracker retained a refresh retry");
  assertRecovery(observerDisconnects === 2 && mutationDisconnects === 2 && runtimeRemoves === 2, "synchronous invalidation cleanup was incomplete");

  sendMode = "normal";
  healthIsCurrent = true;
  await eval(CONTENT_SOURCE);
  const afterSynchronousInvalidation = globalThis.__watchwiseContentLifecycle;
  assertRecovery(afterSynchronousInvalidation !== replacement && !afterSynchronousInvalidation.isDisposed(), "recovery after synchronous invalidation failed");

  const fullscreenRoot = new Element("fullscreen");
  document.fullscreenElement = fullscreenRoot;
  let regularToast = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Regular toast" }, {}, (response) => { regularToast = response; });
  assertRecovery(regularToast?.shown === true, "regular toast was not acknowledged after DOM append");
  let cooledToast = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Too soon" }, {}, (response) => { cooledToast = response; });
  assertRecovery(cooledToast?.shown === false, "ordinary toast cooldown returned a false-positive acknowledgement");
  let goalToast = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Goal", priority: "goal_checkin", actionLabel: "Open", action: { type: "open_panel" } }, {}, (response) => { goalToast = response; });
  assertRecovery(goalToast?.shown === true, "goal toast did not bypass the unrelated toast cooldown");
  assertRecovery(fullscreenRoot.children.some((node) => node.id === "watchwise-toast-host"), "toast was not appended inside the fullscreen element");

  class ThrowingFullscreenRoot extends Element { append() { throw new Error("fullscreen append failed"); } }
  document.fullscreenElement = new ThrowingFullscreenRoot("fullscreen");
  let thrownAppend = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Goal", priority: "goal_checkin" }, {}, (response) => { thrownAppend = response; });
  assertRecovery(thrownAppend?.ok === true && thrownAppend.shown === false, "throwing fullscreen append produced an uncaught or false-positive acknowledgement");
  document.fullscreenElement = new HTMLVideoElement();
  let directVideoFullscreen = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Goal", priority: "goal_checkin" }, {}, (response) => { directVideoFullscreen = response; });
  assertRecovery(directVideoFullscreen?.shown === false, "direct-video fullscreen falsely acknowledged an invisible toast");
  document.fullscreenElement = new HTMLIFrameElement("iframe");
  let directFrameFullscreen = null;
  runtimeListener({ type: "SHOW_TOAST", text: "Goal", priority: "goal_checkin" }, {}, (response) => { directFrameFullscreen = response; });
  assertRecovery(directFrameFullscreen?.shown === false, "direct-iframe fullscreen falsely acknowledged an invisible toast");
  document.fullscreenElement = fullscreenRoot;

  sendMode = "throw_invalidated";
  const toastAction = createdElements.filter((node) => node.className === "primary").at(-1);
  assertRecovery(typeof toastAction?.listeners.click === "function", "toast action fixture was not created");
  toastAction.listeners.click();
  assertRecovery(afterSynchronousInvalidation.isDisposed(), "a synchronous invalidated toast action did not self-dispose");
  assertRecovery(observerDisconnects === 3 && mutationDisconnects === 3 && runtimeRemoves === 3, "toast invalidation cleanup was incomplete");

  sendMode = "normal";
  await eval(CONTENT_SOURCE);
  const afterToastInvalidation = globalThis.__watchwiseContentLifecycle;
  assertRecovery(afterToastInvalidation !== afterSynchronousInvalidation && !afterToastInvalidation.isDisposed(), "recovery after toast invalidation failed");

  sendMode = "reject_invalidated";
  await afterToastInvalidation.refresh();
  await Promise.resolve();
  assertRecovery(afterToastInvalidation.isDisposed(), "a rejected invalidated-context send did not self-dispose");
  assertRecovery(observerDisconnects === 4 && mutationDisconnects === 4 && runtimeRemoves === 4, "rejected invalidation cleanup was incomplete");
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
