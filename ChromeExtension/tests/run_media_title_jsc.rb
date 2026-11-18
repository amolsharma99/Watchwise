#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
content = File.read(File.join(root, "content.js"))
start = content.index("  function cleanTitle(value)")
finish = content.index("  function emit(video", start || 0)
abort "Could not extract media-title helpers" unless start && finish
helpers = content[start...finish]

fixture = <<~JAVASCRIPT
  let selectorNodes = {};
  globalThis.location = { hostname: "www.netflix.com", pathname: "/watch/123", href: "https://www.netflix.com/watch/123" };
  globalThis.navigator = { mediaSession: { metadata: null } };
  globalThis.document = {
    title: "Netflix",
    querySelector(selector) { return selectorNodes[selector] || null; }
  };
  function canonicalURL() { return location.href; }
  #{helpers}
  function assertTitle(actual, expected, label) { if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`); }
  function video(attributes = {}) { return { getAttribute(name) { return attributes[name] ?? null; } }; }
  function meta(content) { return { getAttribute(name) { return name === "content" ? content : null; } }; }
  function resetNetflix() {
    location.hostname = "www.netflix.com"; location.pathname = "/watch/123"; location.href = "https://www.netflix.com/watch/123";
    navigator.mediaSession.metadata = null; document.title = "Netflix"; selectorNodes = {};
  }

  resetNetflix();
  navigator.mediaSession.metadata = { title: "  The\u0000   Crown  " };
  assertTitle(mediaTitle(video({ title: "Lower priority title" })), "The Crown", "Media Session priority and sanitization");

  resetNetflix();
  navigator.mediaSession.metadata = { title: "Netflix" };
  selectorNodes['meta[property="og:title"]'] = meta("Watch Dark | Netflix Official Site");
  assertTitle(mediaTitle(video()), "Dark", "Open Graph Netflix normalization");

  resetNetflix();
  selectorNodes['meta[property="og:title"]'] = meta("Watch Stale Show | Netflix Official Site");
  selectorNodes['[data-uia="video-title"]'] = { textContent: "CurrentEpisode", childNodes: [{ textContent: "Current" }, { textContent: "Episode" }] };
  assertTitle(mediaTitle(video()), "Current Episode", "Current Netflix player title beats stale page metadata");

  resetNetflix();
  selectorNodes['[data-uia="video-title"]'] = { textContent: "ShowE7Episode", childNodes: [{ textContent: "Show" }, { textContent: "E7" }, { textContent: "Episode" }] };
  assertTitle(mediaTitle(video()), "Show E7 Episode", "Netflix player title joins immediate child text");

  resetNetflix();
  selectorNodes['meta[property="og:title"]'] = meta("Netflix");
  selectorNodes['meta[name="twitter:title"]'] = meta("Netflix - Watch TV Shows Online");
  selectorNodes['[data-uia="video-title"]'] = { textContent: "  Episode\u0007   Eight " };
  assertTitle(mediaTitle(video()), "Episode Eight", "Exact Netflix video-title fallback");

  resetNetflix();
  selectorNodes['[data-uia="player-title"]'] = { textContent: "A Better Series" };
  assertTitle(mediaTitle(video()), "A Better Series", "Exact Netflix player-title fallback");

  resetNetflix();
  location.pathname = "/browse"; location.href = "https://www.netflix.com/browse";
  selectorNodes['[data-uia="video-title"]'] = { textContent: "Private browse text" };
  assertTitle(mediaTitle(video()), "Untitled video", "Netflix selector scope");

  selectorNodes = {}; navigator.mediaSession.metadata = null;
  location.hostname = "video.example"; location.pathname = "/watch"; location.href = "https://video.example/watch";
  document.title = "Creator Guide | Video Site";
  assertTitle(mediaTitle(video()), "Creator Guide | Video Site", "Generic-site document title");
  assertTitle(mediaTitle(video({ "aria-label": `  Useful\u0000 ${"x".repeat(400)}  ` })).length, 300, "Title length cap");

  print("Media title selection: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-media-title", ".mjs"])
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
      raise "Media-title JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Media-title test did not report PASS" unless stdout.include?("Media title selection: PASS")
puts "Media title selection: PASS"
