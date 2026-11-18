(() => {
  "use strict";

  if (window.top !== window || location.origin !== "https://aistudio.google.com" || location.pathname !== "/prompts/new_chat") return;
  const deadline = Date.now() + 20_000;
  let pending = null;
  let finished = false;

  function runtimeAvailable() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function composer() {
    return document.querySelector('textarea[formcontrolname="promptText"][aria-label="Enter a prompt"]')
      || document.querySelector('textarea[aria-label="Enter a prompt"]');
  }

  function showFallback(prompt, message) {
    const host = document.createElement("div");
    host.id = "watchwise-studio-prefill-help";
    host.style.cssText = "all:initial;position:fixed;right:20px;top:20px;z-index:2147483647;max-width:calc(100vw - 40px)";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ".card{box-sizing:border-box;width:min(340px,calc(100vw - 40px));padding:14px;border:1px solid #d7c8b5;border-radius:14px;background:#faf9f6;box-shadow:0 12px 36px #20180f33;color:#252420;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.title{font-weight:750;margin-bottom:5px}p{margin:0 0 9px}textarea{box-sizing:border-box;width:100%;height:88px;padding:8px;border:1px solid #a9957e;border-radius:8px;background:white;color:#252420;font:12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;resize:vertical}button{margin:8px 8px 0 0;padding:7px 10px;border:0;border-radius:8px;background:#705037;color:white;font:700 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer}button.quiet{background:#e8e1d7;color:#252420}button:focus-visible,textarea:focus-visible{outline:2px solid #ae8055;outline-offset:2px}";
    const card = document.createElement("section");
    card.className = "card";
    card.setAttribute("role", "status");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Watchwise prompt";
    const explanation = document.createElement("p");
    explanation.textContent = message;
    const field = document.createElement("textarea");
    field.readOnly = true;
    field.value = prompt;
    field.setAttribute("aria-label", "Video summary prompt to copy");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy prompt";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(prompt); copy.textContent = "Copied — paste into Studio"; }
      catch { field.focus(); field.select(); copy.textContent = "Select and copy the prompt"; }
    });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "quiet";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => host.remove());
    card.append(title, explanation, field, copy, dismiss);
    shadow.append(style, card);
    document.documentElement.append(host);
  }

  async function finish() {
    finished = true;
    if (!pending || !runtimeAvailable()) return;
    try { await chrome.runtime.sendMessage({ type: "STUDIO_PROMPT_HANDLED", token: pending.token }); } catch {}
  }

  function retry() {
    if (finished || !runtimeAvailable()) return;
    if (Date.now() >= deadline) {
      if (pending) {
        showFallback(pending.prompt, "Studio did not expose an empty prompt field. Copy this prompt and paste it into a new chat.");
        void finish();
      }
      return;
    }
    setTimeout(() => { void attempt(); }, 350);
  }

  async function attempt() {
    if (finished || !runtimeAvailable() || location.origin !== "https://aistudio.google.com" || location.pathname !== "/prompts/new_chat") return;
    if (!pending) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "GET_STUDIO_PROMPT" });
        if (response?.ok && response.pending && typeof response.prompt === "string" && typeof response.token === "string") pending = response;
      } catch {}
    }
    if (!pending) { retry(); return; }
    const editor = composer();
    if (!editor) { retry(); return; }
    if (editor.value === pending.prompt) { await finish(); return; }
    if (editor.value.trim()) {
      showFallback(pending.prompt, "This chat already has text. Watchwise left it untouched; copy the video prompt below if you want it.");
      await finish();
      return;
    }
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("No text editor setter");
      editor.focus({ preventScroll: true });
      setter.call(editor, pending.prompt);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: pending.prompt }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (editor.isConnected && editor.value === pending.prompt) { await finish(); return; }
    } catch {}
    showFallback(pending.prompt, "Studio did not accept the prepared prompt. Copy it below and paste it into the chat.");
    await finish();
  }

  void attempt();
})();
