#!/usr/bin/env ruby
require "open3"
require "tempfile"

root = File.expand_path("..", __dir__)
%w[studio-handoff.js store-local/studio-handoff.js].each do |filename|
script = File.read(File.join(root, filename))
fixture = <<~JAVASCRIPT
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.hidden = false; this.isConnected = false; this.style = {}; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    append(...children) { for (const child of children) { if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child); this.children.push(child); child.parent = this; child.isConnected = this.isConnected; } }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
    attachShadow() { this.shadow = new Element("shadow"); this.shadow.isConnected = true; return this.shadow; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
  }
  const documentRoot = new Element("html"); documentRoot.isConnected = true;
  const actionRow = new Element("actions"); documentRoot.append(actionRow);
  const documentListeners = {};
  let rowAvailable = true;
  function findElement(root, id) { if (root.id === id && root.isConnected) return root; for (const child of root.children) { const found = findElement(child, id); if (found) return found; } return null; }
  const document = {
    documentElement: documentRoot,
    fullscreenElement: null,
    hidden: false,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => findElement(documentRoot, id),
    querySelector: (selector) => selector.includes("ytd-watch-metadata") && rowAvailable ? actionRow : null,
    addEventListener(name, callback) { documentListeners[name] = callback; }, removeEventListener(name) { delete documentListeners[name]; },
    execCommand() { return false; }
  };
  const windowListeners = {};
  const window = { addEventListener(name, callback) { windowListeners[name] = callback; }, removeEventListener(name) { delete windowListeners[name]; } }; window.top = window;
  let intervalCallback = null;
  function setInterval(callback) { intervalCallback = callback; return 1; }
  function clearInterval() { intervalCallback = null; }
  function setTimeout() { return 1; }
  function clearTimeout() {}
  const location = { href: "https://www.youtube.com/watch?feature=share&v=abc_123-XYZ&t=20" };
  const copied = [];
  const messages = [];
  let copyFails = false;
  let openFails = false;
  let pauseCopy = false;
  let resolveCopy = null;
  const navigator = { clipboard: { async writeText(value) { if (copyFails) throw new Error("blocked"); copied.push(value); if (pauseCopy) await new Promise((resolve) => { resolveCopy = resolve; }); } } };
  const chrome = { runtime: { id: "watchwise-test", async sendMessage(message) { messages.push(message); return { ok: !openFails }; } } };
  function check(value, message) { if (!value) throw new Error(message); }
  const prefillExpected = #{filename == "studio-handoff.js"};
  #{script}
  const controller = globalThis.__watchwiseStudioHandoff;
  function host() { return document.getElementById("watchwise-studio-handoff-host"); }
  function parts() { const wrap = host().shadow.children[1]; return { button: wrap.children[0], status: wrap.children[1], manual: wrap.children[2] }; }
  check(host() && messages.length === 0, "watch page did not render a quiet, no-request action");
  check(parts().manual.children[2].href === "https://aistudio.google.com/prompts/new_chat", "manual fallback does not lead to Studio's new chat");
  if (prefillExpected) check(parts().button.innerHTML.includes("Summarise in Gemini AI Studio"), "requested button label is missing");
  check(host().shadow.children[0].textContent.includes(".wrap{display:block") && host().shadow.children[0].textContent.includes(".hint{position:fixed") && host().shadow.children[0].textContent.includes(".manual{position:fixed"), "feedback can expand YouTube's action row");
  check(host().parent === actionRow, "button is not in the YouTube action row");
  const firstHost = host(); intervalCallback();
  check(host() === firstHost, "poll duplicated the action");
  rowAvailable = false; intervalCallback();
  check(host().parent === documentRoot && host().style.cssText.includes("top:76px"), "missing action row did not use a safe temporary placement");
  rowAvailable = true; intervalCallback();
  check(host() === firstHost && host().parent === actionRow, "action did not move into YouTube's action row");
  parts().button.listeners.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  check(copied.length === 1 && copied[0].includes("https://www.youtube.com/watch?v=abc_123-XYZ"), "canonical URL was not copied");
  check(!copied[0].includes("feature=share") && !copied[0].includes("t=20"), "tracking parameters leaked into prompt");
  check(copied[0] === "Summarise the video with topics and bullets for each - https://www.youtube.com/watch?v=abc_123-XYZ", "copied prompt differs from the requested wording");
  check(messages.length === 1 && messages[0].type === "OPEN_AI_STUDIO", "Studio did not open only after copying");
  check(parts().manual.hidden && parts().status.textContent === "", "successful handoff left feedback in the action row");

  location.href = "https://www.youtube.com/shorts/abc_123-XYZ"; intervalCallback();
  check(!host(), "Short incorrectly shows the action");
  location.href = "https://www.youtube.com/"; intervalCallback();
  check(!host(), "YouTube home incorrectly shows the action");
  location.href = "https://www.youtube.com/watch?v=one&v=two"; intervalCallback();
  check(!host(), "ambiguous duplicate video IDs incorrectly show the action");
  location.href = "https://youtube.com/watch?v=second"; intervalCallback();
  check(host() && host() !== firstHost, "SPA navigation to a watch page did not restore the action");
  document.fullscreenElement = new Element("video"); intervalCallback();
  check(!host(), "button overlays fullscreen video");
  document.fullscreenElement = null; intervalCallback();
  check(host(), "button did not return after fullscreen");

  copyFails = true;
  parts().button.listeners.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  check(messages.length === (prefillExpected ? 2 : 1), "copy failure did not follow the edition's fallback policy");
  if (prefillExpected) check(parts().manual.hidden && parts().status.textContent === "", "successful prefill showed a redundant manual prompt when clipboard failed");
  else check(parts().manual.hidden === false && parts().manual.children[1].value.includes("watch?v=second"), "copy failure did not provide manual prompt");
  openFails = true;
  parts().button.listeners.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  check(!parts().manual.hidden && parts().manual.children[1].value.includes("watch?v=second"), "opening failure lost the manual prompt");
  documentListeners.visibilitychange();
  check(parts().manual.hidden && parts().status.textContent === "", "returning to the tab did not reset transient feedback");
  openFails = true;
  parts().button.listeners.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  windowListeners.pageshow();
  check(parts().manual.hidden && parts().status.textContent === "", "page restoration did not reset transient feedback");
  openFails = false;
  copyFails = false; pauseCopy = true;
  const beforeNavigation = messages.length;
  parts().button.listeners.click();
  for (let i = 0; i < 3; i++) await Promise.resolve();
  location.href = "https://www.youtube.com/watch?v=third"; intervalCallback();
  resolveCopy();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  check(messages.length === beforeNavigation, "navigation during clipboard copy opened Studio for a stale video");
  location.href = "https://www.youtube.com/watch?v=fourth"; intervalCallback();
  parts().button.listeners.click();
  for (let i = 0; i < 3; i++) await Promise.resolve();
  host().remove();
  resolveCopy();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  check(messages.length === beforeNavigation + 1 && host(), "a replaced button silently abandoned its clicked handoff");
  pauseCopy = false;
  location.href = "https://notyoutube.com/watch?v=abc"; intervalCallback();
  check(!host(), "lookalike host incorrectly shows the action");
  controller.dispose();
  print("Studio handoff URL/SPA/clipboard contract: PASS");
JAVASCRIPT

Tempfile.create(["watchwise-studio-handoff", ".mjs"]) do |file|
  file.write(fixture)
  file.flush
  output, error, result = Open3.capture3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path)
  abort [output, error].join("\n") unless result.success? && output.include?("Studio handoff URL/SPA/clipboard contract: PASS")
end

puts "Studio handoff URL/SPA/clipboard contract: PASS (#{filename})"
end
