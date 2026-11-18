#!/usr/bin/env ruby
require "open3"
require "tempfile"

root = File.expand_path("..", __dir__)
script = File.read(File.join(root, "studio-prefill.js"))

%w[empty occupied late no_pending].each do |scenario|
  fixture = <<~JAVASCRIPT
    const scenario = #{scenario.inspect};
    const prompt = "Summarise the video with topics and bullets for each - https://www.youtube.com/watch?v=abc";
    const sent = [];
    const timers = [];
    const hosts = [];
    let editorReady = scenario !== "late";
    let getCount = 0;
    class HTMLTextAreaElement {
      constructor() { this._value = scenario === "occupied" ? "User's draft" : ""; this.isConnected = true; this.events = []; this.style = {}; }
      get value() { return this._value; }
      set value(value) { this._value = value; }
      focus() { this.focused = true; }
      select() { this.selected = true; }
      setAttribute() {}
      dispatchEvent(event) { this.events.push(event.type); return true; }
    }
    class InputEvent { constructor(type) { this.type = type; } }
    class Element {
      constructor(tag) { this.tagName = tag; this.style = {}; this.children = []; }
      attachShadow() { this.shadow = new Element("shadow"); return this.shadow; }
      append(...children) { this.children.push(...children); }
      setAttribute() {}
      addEventListener() {}
    }
    const editor = new HTMLTextAreaElement();
    const document = {
      querySelector() { return editorReady ? editor : null; },
      createElement(tag) { return new Element(tag); },
      documentElement: { append(host) { hosts.push(host); } }
    };
    const window = {}; window.top = window;
    const location = { origin: "https://aistudio.google.com", pathname: "/prompts/new_chat" };
    const chrome = { runtime: { id: "watchwise-test", async sendMessage(message) {
      sent.push(message);
      if (message.type === "GET_STUDIO_PROMPT") {
        getCount++;
        return scenario === "no_pending" || (scenario === "late" && getCount === 1)
          ? { ok: true, pending: false }
          : { ok: true, pending: true, prompt, token: "one-time-token" };
      }
      return { ok: true };
    } } };
    const navigator = { clipboard: { async writeText() {} } };
    function setTimeout(callback) { timers.push(callback); return timers.length; }
    function check(value, message) { if (!value) throw new Error(message); }
    #{script}
    for (let i = 0; i < 15; i++) {
      for (let j = 0; j < 8; j++) await Promise.resolve();
      if (scenario === "late" && getCount >= 2) editorReady = true;
      const callback = timers.shift();
      if (callback) callback();
    }
    if (scenario === "empty" || scenario === "late") {
      check(editor.value === prompt && editor.events.includes("input"), "empty Studio composer was not filled through an input event");
      check(sent.some((message) => message.type === "STUDIO_PROMPT_HANDLED" && message.token === "one-time-token"), "successful handoff was not acknowledged");
      check(hosts.length === 0, "successful handoff showed a fallback overlay");
    } else if (scenario === "occupied") {
      check(editor.value === "User's draft", "an existing Studio draft was overwritten");
      check(hosts.length === 1, "occupied composer did not provide a manual fallback");
      check(sent.some((message) => message.type === "STUDIO_PROMPT_HANDLED"), "occupied handoff was not cleared");
    } else {
      check(editor.value === "" && hosts.length === 0, "a normal Studio chat without a pending handoff was changed");
    }
    check(!sent.some((message) => message.type === "RUN" || message.type === "SUBMIT"), "prompt was automatically submitted");
    print("Studio prefill #{scenario}: PASS");
  JAVASCRIPT

  Tempfile.create(["watchwise-studio-prefill", ".mjs"]) do |file|
    file.write(fixture)
    file.flush
    output, error, result = Open3.capture3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path)
    abort [output, error].join("\n") unless result.success? && output.include?("Studio prefill #{scenario}: PASS")
  end
  puts "Studio prefill #{scenario}: PASS"
end
