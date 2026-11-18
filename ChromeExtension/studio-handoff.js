(() => {
  "use strict";

  if (window.top !== window) return;
  const CONTROLLER_KEY = "__watchwiseStudioHandoff";
  try { globalThis[CONTROLLER_KEY]?.dispose?.(); } catch {}
  const HOST_ID = "watchwise-studio-handoff-host";
  const STUDIO_URL = "https://aistudio.google.com/prompts/new_chat";
  let host = null;
  let button = null;
  let status = null;
  let manual = null;
  let manualText = null;
  let currentVideoURL = null;
  let disposed = false;

  // Only public, standard YouTube watch URLs. Shorts, live streams, feeds and
  // embeds have no action. Query parameters other than the video ID are dropped.
  function canonicalWatchURL(input) {
    const match = /^https:\/\/([^/?#]+)\/watch\?([^#]*)/.exec(String(input || ""));
    if (!match || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(match[1].toLowerCase())) return null;
    let videoID = null;
    let videoIDCount = 0;
    for (const pair of match[2].split("&")) {
      const [name, rawValue = ""] = pair.split("=", 2);
      if (name !== "v") continue;
      videoIDCount += 1;
      if (videoIDCount > 1) return null;
      try { videoID = decodeURIComponent(rawValue); } catch { return null; }
    }
    return videoIDCount === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(videoID || "")
      ? `https://www.youtube.com/watch?v=${videoID}` : null;
  }

  function studioPrompt(url) {
    return `Summarise the video with topics and bullets for each - ${url}`;
  }

  function runtimeAvailable() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function removeHost() {
    host?.remove();
    host = button = status = manual = manualText = null;
  }

  function actionTarget() {
    return document.querySelector("ytd-watch-metadata #top-level-buttons-computed")
      || document.querySelector("ytd-watch-metadata #actions");
  }

  function placeHost() {
    if (!host) return;
    const target = actionTarget();
    if (target) {
      host.style.cssText = "all:initial;display:inline-flex;align-items:center;position:relative;margin-left:8px;vertical-align:middle;max-width:100%";
      if (host.parentNode !== target) target.append(host);
    } else {
      // A temporary fallback while YouTube is still rendering its action row.
      // Keep it away from the player controls at the bottom of the viewport.
      host.style.cssText = "all:initial;position:fixed;z-index:2147483645;right:18px;top:76px;max-width:calc(100vw - 36px)";
      if (host.parentNode !== document.documentElement) document.documentElement.append(host);
    }
  }

  function legacyCopy(text) {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.documentElement.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand("copy") === true; } catch {}
    field.remove();
    return copied;
  }

  async function copyPrompt(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    return legacyCopy(text);
  }

  async function handleClick() {
    const url = canonicalWatchURL(location.href);
    if (!url || disposed || !runtimeAvailable()) { sync(); return; }
    button.disabled = true;
    status.textContent = "Preparing your Gemini AI Studio prompt…";
    const prompt = studioPrompt(url);
    try {
      const copied = await copyPrompt(prompt);
      if (disposed || canonicalWatchURL(location.href) !== url) return;
      if (!host?.isConnected) sync();
      let opened = false;
      try { opened = (await chrome.runtime.sendMessage({ type: "OPEN_AI_STUDIO" }))?.ok === true; } catch {}
      if (disposed || canonicalWatchURL(location.href) !== url) return;
      if (!host?.isConnected) sync();
      if (!opened) {
        manual.hidden = false;
        manualText.value = prompt;
        status.textContent = copied ? "Prompt copied. Open Studio below and paste it." : "Studio could not open. Copy the prompt below and paste it there.";
      } else {
        manual.hidden = copied;
        if (!copied) manualText.value = prompt;
        status.textContent = "Prompt opening in Gemini AI Studio. Review it before pressing Run.";
      }
    } catch {
      if (!disposed && canonicalWatchURL(location.href) === url) {
        if (!host?.isConnected) sync();
        manual.hidden = false;
        manualText.value = prompt;
        status.textContent = "Copy was blocked. Copy the prompt below, then open Studio.";
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  function createHost() {
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .wrap{display:grid;gap:6px;max-width:320px}
      button{cursor:pointer;border:1px solid rgba(232,209,179,.32);border-radius:999px;padding:10px 14px;background:rgba(37,36,32,.95);box-shadow:0 8px 24px rgba(17,15,12,.20);backdrop-filter:blur(14px);color:#faf7f1;font:650 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left}
      button:hover{background:#3a3027;border-color:#c69868}button:disabled{opacity:.7;cursor:wait}
      button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #d4a16f;outline-offset:3px}
      .spark{color:#d4a16f;margin-right:7px}.hint{font:500 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4eee3;background:rgba(37,36,32,.88);border-radius:8px;padding:5px 8px;width:max-content;max-width:100%}
      .manual{display:grid;gap:8px;background:#faf9f6;border:1px solid #dcd6cb;border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(17,15,12,.18)}.manual[hidden],.hint:empty{display:none}
      textarea{box-sizing:border-box;width:290px;max-width:100%;height:92px;resize:vertical;border:1px solid #b7aa9b;border-radius:7px;padding:8px;background:#fff;color:#252420;font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      a{color:#705037;font:700 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none}a:hover{text-decoration:underline}
      @media(max-width:480px){.wrap{max-width:calc(100vw - 36px)}}
    `;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Summarise in Gemini AI Studio");
    button.title = "Opens Gemini AI Studio with a prepared prompt for you to review and run.";
    button.innerHTML = '<span class="spark" aria-hidden="true">✦</span>Summarise in Gemini AI Studio';
    button.addEventListener("click", () => { void handleClick(); });
    status = document.createElement("div");
    status.className = "hint";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    manual = document.createElement("div");
    manual.className = "manual";
    manual.hidden = true;
    manualText = document.createElement("textarea");
    manualText.readOnly = true;
    manualText.setAttribute("aria-label", "Studio prompt to copy manually");
    const open = document.createElement("a");
    open.href = STUDIO_URL;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open Gemini AI Studio ↗";
    manual.append(manualText, open);
    wrap.append(button, status, manual);
    shadow.append(style, wrap);
    placeHost();
  }

  function sync() {
    if (disposed) return;
    if (!runtimeAvailable()) { dispose(); return; }
    const url = !document.fullscreenElement ? canonicalWatchURL(location.href) : null;
    if (!url) { currentVideoURL = null; removeHost(); return; }
    if (url !== currentVideoURL) { currentVideoURL = url; removeHost(); }
    if (!host?.isConnected) createHost();
    else placeHost();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    removeHost();
    document.removeEventListener("yt-navigate-finish", sync);
    document.removeEventListener("fullscreenchange", sync);
    window.removeEventListener("popstate", sync);
    window.removeEventListener("pageshow", sync);
    if (globalThis[CONTROLLER_KEY]?.dispose === dispose) delete globalThis[CONTROLLER_KEY];
  }

  const timer = setInterval(sync, 1_500);
  document.addEventListener("yt-navigate-finish", sync);
  document.addEventListener("fullscreenchange", sync);
  window.addEventListener("popstate", sync);
  window.addEventListener("pageshow", sync);
  globalThis[CONTROLLER_KEY] = { dispose };
  sync();
})();
