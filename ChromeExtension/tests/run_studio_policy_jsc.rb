#!/usr/bin/env ruby
require "open3"
require "tempfile"

root = File.expand_path("..", __dir__)
background = File.read(File.join(root, "background.js"))
handoff = File.read(File.join(root, "studio-handoff.js"))
background_helpers = %w[standardYouTubeWatchID studioPromptForVideo studioPromptKey isStudioComposerSender].map do |name|
  single_line = background[/^function #{name}\([^\n]*\) \{[^\n]*\}$/, 0]
  single_line || background[/^function #{name}\([^\n]*\).*?^\}/m] || abort("Missing #{name}")
end.join("\n")
content_prompt = handoff[/  function studioPrompt\(url\) \{.*?\n  \}/m] || abort("Missing content prompt")

fixture = <<~JAVASCRIPT
  const STUDIO_PROMPT_PREFIX = "watchwiseStudioPrompt:";
  const chrome = { runtime: { id: "watchwise-test" } };
  class URL {
    constructor(input) {
      const [scheme, rest] = String(input).split("://");
      if (!scheme || !rest) throw new TypeError("Invalid URL");
      this.protocol = `${scheme}:`;
      this.hostname = rest.split("/")[0];
      const pathAndQuery = rest.slice(this.hostname.length).split("#")[0];
      this.pathname = pathAndQuery.split("?")[0] || "/";
      const query = pathAndQuery.split("?")[1] || "";
      this.searchParams = { getAll(name) {
        return query.split("&").filter((part) => part.split("=")[0] === name).map((part) => part.split("=")[1] || "");
      } };
    }
  }
  #{background_helpers}
  #{content_prompt}
  function check(value, message) { if (!value) throw new Error(message); }
  const valid = { id: chrome.runtime.id, frameId: 0, url: "https://aistudio.google.com/prompts/new_chat", tab: { id: 12, url: "https://aistudio.google.com/prompts/new_chat" } };
  check(isStudioComposerSender(valid), "current top-frame Studio chat was rejected");
  check(!isStudioComposerSender({ ...valid, frameId: 1 }), "Studio subframe gained prompt access");
  check(!isStudioComposerSender({ ...valid, id: "other-extension" }), "other extension gained prompt access");
  check(!isStudioComposerSender({ ...valid, url: "https://aistudio.google.com/usage" }), "Studio Usage page gained prompt access");
  check(!isStudioComposerSender({ ...valid, tab: { id: 12, url: "https://aistudio.google.com/usage" } }), "navigated Studio tab gained prompt access");
  check(!isStudioComposerSender({ ...valid, url: "https://aistudio.google.com.evil.test/prompts/new_chat" }), "lookalike Studio host gained prompt access");
  check(standardYouTubeWatchID("https://www.youtube.com/watch?v=abc&v=def") === null, "ambiguous watch URL accepted");
  check(standardYouTubeWatchID("https://www.youtube.com/watch?v=abc") === "abc", "valid watch URL rejected");
  check(studioPromptForVideo("abc") === "Summarise the video with topics and bullets for each - https://www.youtube.com/watch?v=abc", "pre-filled prompt changed");
  check(studioPromptForVideo("abc") === studioPrompt("https://www.youtube.com/watch?v=abc"), "copied and prefilled prompts differ");
  check(studioPromptKey(12) === "watchwiseStudioPrompt:12", "pending prompt key is not tab-scoped");
  print("Studio sender/prompt policy: PASS");
JAVASCRIPT

Tempfile.create(["watchwise-studio-policy", ".mjs"]) do |file|
  file.write(fixture)
  file.flush
  output, error, result = Open3.capture3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path)
  abort [output, error].join("\n") unless result.success? && output.include?("Studio sender/prompt policy: PASS")
end

puts "Studio sender/prompt policy: PASS"
