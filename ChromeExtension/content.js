(async () => {
  "use strict";

  const CONTENT_LIFECYCLE = "watchwise-tracker-v0.3.9";
  const CONTROLLER_KEY = "__watchwiseContentLifecycle";
  const previousController = globalThis[CONTROLLER_KEY];
  if (previousController?.probe) {
    let healthy = false;
    try { healthy = await previousController.probe(); } catch {}
    if (globalThis[CONTROLLER_KEY] !== previousController) return;
    if (healthy) {
      previousController.refresh?.();
      return;
    }
  }
  // Claim synchronously before installing observers. Concurrent recovery
  // executions then see the claim, and only one can replace it.
  const startupClaim = { lifecycle: CONTENT_LIFECYCLE, probe: async () => false, deactivate() {} };
  globalThis[CONTROLLER_KEY] = startupClaim;
  try { previousController?.deactivate?.(); } catch {}

  const HEARTBEAT_MS = 5_000;
  const MIN_EVENT_GAP_MS = 3_000;
  const MIN_VISIBLE_RATIO = 0.25;
  const MIN_VISIBLE_AREA_PX = 12_000;
  const TOAST_COOLDOWN_MS = 60_000;
  const REFRESH_RETRY_MS = 1_000;
  const MAX_REFRESH_RETRIES = 3;
  let trackingEnabled = false;
  let disposed = false;
  let deactivating = false;
  let refreshRetryTimer = null;
  let refreshRetryAttempts = 0;
  let refreshEpoch = 0;
  const lifecycleAbortController = new AbortController();
  let lastToastAt = 0;
  const players = new WeakMap();
  const trackedVideos = new Set();

  function isExtensionContextInvalidated(error) {
    const message = String(error?.message || error || "").trim().toLowerCase();
    let runtimeAvailable = true;
    try { runtimeAvailable = Boolean(chrome.runtime?.id); } catch { runtimeAvailable = false; }
    return !runtimeAvailable || /^(?:extension context invalidated|the extension context has been invalidated)\.?$/.test(message);
  }

  function handleRuntimeFailure(error) {
    if (isExtensionContextInvalidated(error) && !disposed && !deactivating) deactivateLifecycle(false);
  }

  function sendRuntimeMessage(message) {
    if (disposed) return Promise.resolve(null);
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch((error) => {
        handleRuntimeFailure(error);
        return null;
      });
    } catch (error) {
      handleRuntimeFailure(error);
      return Promise.resolve(null);
    }
  }

  function uuid() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function canonicalURL() {
    const url = new URL(location.href);
    url.username = "";
    url.password = "";
    url.hash = "";
    const hostname = url.hostname.toLowerCase();
    const isYouTube = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
    const videoID = isYouTube ? url.searchParams.get("v") : null;
    url.search = "";
    if (videoID && /^[A-Za-z0-9_-]{1,64}$/.test(videoID)) url.searchParams.set("v", videoID);
    return url.toString().slice(0, 2_048);
  }

  function sourceIdentity(video) {
    const rawSource = String(video.currentSrc || video.src || "").slice(0, 2_048);
    let stableSource = rawSource;
    try {
      const source = new URL(rawSource, location.href);
      source.username = "";
      source.password = "";
      source.hash = "";
      source.search = "";
      stableSource = source.toString();
    } catch {}
    return `${canonicalURL()}\n${stableSource}`;
  }

  function playbackState(video, reason) {
    if (video.ended || reason === "ended") return "ended";
    if (reason === "seeking") return "seeking";
    return video.paused ? "paused" : (reason === "heartbeat" ? "heartbeat" : "playing");
  }

  function cleanTitle(value) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function normalizeMediaTitle(value) {
    let title = cleanTitle(value);
    const hostname = location.hostname.toLowerCase();
    const isNetflix = hostname === "netflix.com" || hostname.endsWith(".netflix.com");
    if (isNetflix) {
      title = title
        .replace(/^watch\s+(.+?)\s+(?:\||·|–|-)\s+netflix(?: official site)?$/i, "$1")
        .replace(/\s+(?:\||·|–|-)\s+netflix(?: official site)?$/i, "");
    }
    return cleanTitle(title);
  }

  function netflixPlayerMetadataTitle(node) {
    if (!node) return null;
    const parts = Array.from(node.childNodes || []).map((child) => cleanTitle(child.textContent)).filter(Boolean);
    return cleanTitle(parts.length ? parts.join(" ") : node.textContent);
  }

  function mediaTitle(video) {
    const generic = /^(?:youtube|shorts?|youtube shorts?|video|video player|untitled(?: video)?|netflix(?:\.com)?(?:\s*(?:\||·|–|-|:)\s*.*)?)$/i;
    const hostname = location.hostname.toLowerCase();
    const isNetflixWatch = (hostname === "netflix.com" || hostname.endsWith(".netflix.com")) && /^\/watch\//.test(location.pathname);
    const metadataTitle = navigator.mediaSession?.metadata?.title;
    const openGraphTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute("content");
    const netflixTitleNode = isNetflixWatch
      ? document.querySelector('[data-uia="video-title"]') || document.querySelector('[data-uia="player-title"]')
      : null;
    const netflixPlayerTitle = netflixPlayerMetadataTitle(netflixTitleNode);
    for (const candidate of [metadataTitle, video.getAttribute("title"), video.getAttribute("aria-label"), netflixPlayerTitle, openGraphTitle, twitterTitle, document.title]) {
      const title = normalizeMediaTitle(candidate);
      if (title && !generic.test(title)) return title;
    }
    return /^https:\/\/(?:[^/]+\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]{1,64}(?:[/?]|$)/.test(canonicalURL())
      ? "YouTube Short"
      : "Untitled video";
  }

  function emit(video, metadata, state, isVisible, force = false) {
    if (disposed || !trackingEnabled) return;
    const now = Date.now();
    if (!force && now - metadata.lastSentAt < MIN_EVENT_GAP_MS) return;
    const liveDuration = Number(video.duration);
    const livePosition = Number(video.currentTime);
    const liveRate = Number(video.playbackRate);
    const duration = Number.isFinite(liveDuration) ? liveDuration : metadata.lastDuration;
    const position = Number.isFinite(livePosition) ? livePosition : metadata.lastPosition;
    const playbackRate = Number.isFinite(liveRate) ? liveRate : metadata.lastRate;
    if (![duration, position, playbackRate].every(Number.isFinite) || duration <= 0) return;
    metadata.lastSentAt = now;
    if (isVisible) {
      metadata.lastDuration = duration;
      metadata.lastPosition = position;
      metadata.lastRate = playbackRate;
    }
    void sendRuntimeMessage({
      type: "PLAYBACK_EVENT",
      event: {
        schemaVersion: 1,
        playerId: metadata.id,
        title: mediaTitle(video),
        url: canonicalURL(),
        site: location.hostname.toLowerCase(),
        duration,
        position,
        playbackRate,
        state,
        occurredAtMilliseconds: now,
        documentVisible: isVisible
      }
    });
  }

  function terminateIfActive(video, metadata) {
    if (metadata.wasReportable && !video.paused && !video.ended) emit(video, metadata, "paused", false, true);
    metadata.wasReportable = false;
  }

  function rotateIdentityIfNeeded(video, metadata) {
    const identity = sourceIdentity(video);
    if (metadata.identity && metadata.identity !== identity) {
      terminateIfActive(video, metadata);
      metadata.id = uuid();
      metadata.lastSentAt = 0;
    }
    metadata.identity = identity;
  }

  function report(video, reason, force = false) {
    if (disposed || !trackingEnabled) return;
    const metadata = players.get(video);
    if (!metadata?.active) return;
    rotateIdentityIfNeeded(video, metadata);
    const reportable = metadata.intersecting && document.visibilityState === "visible";
    if (!reportable) {
      terminateIfActive(video, metadata);
      return;
    }
    metadata.wasReportable = !video.paused && !video.ended;
    emit(video, metadata, playbackState(video, reason), true, force);
  }

  const intersectionObserver = new IntersectionObserver((entries) => {
    if (!trackingEnabled) return;
    for (const entry of entries) {
      const video = entry.target;
      const metadata = players.get(video);
      if (!metadata?.active) continue;
      const area = entry.intersectionRect.width * entry.intersectionRect.height;
      const visible = entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE_RATIO && area >= MIN_VISIBLE_AREA_PX;
      if (metadata.intersecting && !visible) terminateIfActive(video, metadata);
      metadata.intersecting = visible;
      if (visible && !video.paused && !video.ended) report(video, "heartbeat", true);
    }
  }, { threshold: [0, MIN_VISIBLE_RATIO, 0.5, 1] });

  function activate(video) {
    let metadata = players.get(video);
    if (!metadata) {
      metadata = { id: uuid(), identity: sourceIdentity(video), lastSentAt: 0, heartbeat: null, intersecting: false, wasReportable: false, active: false, lastDuration: null, lastPosition: null, lastRate: null };
      players.set(video, metadata);
      for (const name of ["play", "pause", "seeking", "seeked", "ended", "ratechange", "durationchange", "loadedmetadata", "emptied"]) {
        video.addEventListener(name, () => report(video, name, true), { passive: true, signal: lifecycleAbortController.signal });
      }
    }
    if (metadata.active) return;
    metadata.active = true;
    // Cross-origin frame-local geometry cannot prove that the iframe itself is
    // visible in the top page. Stay fail-closed until IntersectionObserver fires.
    metadata.intersecting = false;
    metadata.identity = sourceIdentity(video);
    intersectionObserver.observe(video);
    metadata.heartbeat = setInterval(() => {
      if (!video.isConnected) { deactivate(video); return; }
      if (!video.paused && !video.ended) report(video, "heartbeat");
    }, HEARTBEAT_MS);
    trackedVideos.add(video);
  }

  function deactivate(video, preserveFinalInterval = true) {
    const metadata = players.get(video);
    if (!metadata?.active) return;
    if (preserveFinalInterval) terminateIfActive(video, metadata);
    else metadata.wasReportable = false;
    metadata.active = false;
    metadata.intersecting = false;
    clearInterval(metadata.heartbeat);
    metadata.heartbeat = null;
    intersectionObserver.unobserve(video);
    trackedVideos.delete(video);
  }

  function startTracking() {
    if (!trackingEnabled) return;
    document.querySelectorAll("video").forEach(activate);
  }

  function stopTracking(preserveFinalInterval = true) {
    for (const video of [...trackedVideos]) deactivate(video, preserveFinalInterval);
  }

  function discoverVideos(root) {
    if (!trackingEnabled) return;
    if (root instanceof HTMLVideoElement) activate(root);
    root.querySelectorAll?.("video").forEach(activate);
  }

  function seekPlayer(playerId, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    for (const video of trackedVideos) {
      if (players.get(video)?.id === playerId && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(seconds, video.duration);
        video.focus({ preventScroll: true });
        return true;
      }
    }
    return false;
  }

  function setTrackingState(enabled) {
    if (disposed) return;
    const next = enabled === true;
    if (trackingEnabled === next) return;
    if (!next) {
      trackingEnabled = false;
      stopTracking(false);
      return;
    }
    trackingEnabled = true;
    startTracking();
  }

  function showToast(message) {
    if (disposed) return false;
    const now = Date.now();
    const isGoalCheckIn = message.priority === "goal_checkin";
    if ((!isGoalCheckIn && now - lastToastAt < TOAST_COOLDOWN_MS) || typeof message.text !== "string") return false;
    const fullscreenRoot = document.fullscreenElement;
    if (fullscreenRoot instanceof HTMLVideoElement) return false;
    document.querySelector("#watchwise-toast-host")?.remove();
    const host = document.createElement("div");
    host.id = "watchwise-toast-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .toast{box-sizing:border-box;width:min(340px,calc(100vw - 40px));padding:14px 15px;border:1px solid rgba(255,255,255,.28);border-radius:16px;background:rgba(22,25,35,.84);box-shadow:0 14px 48px rgba(0,0,0,.32);backdrop-filter:blur(18px);color:#f8fafc;font:500 14px/1.45 system-ui,-apple-system,sans-serif;pointer-events:auto}
      .brand{color:#c4b5fd;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.message{margin:5px 0 11px}.actions{display:flex;gap:8px;justify-content:flex-end}button{border:0;border-radius:9px;padding:7px 10px;font:600 12px system-ui;cursor:pointer}button.primary{background:#8b5cf6;color:white}button.quiet{background:rgba(255,255,255,.10);color:#f8fafc}button:focus-visible{outline:2px solid #ddd6fe;outline-offset:2px}
    `;
    const toast = document.createElement("section");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.textContent = "Watchwise";
    const text = document.createElement("div");
    text.className = "message";
    text.textContent = message.text.slice(0, 240);
    const actions = document.createElement("div");
    actions.className = "actions";
    if (message.actionLabel && message.action) {
      const action = document.createElement("button");
      action.className = "primary";
      action.textContent = String(message.actionLabel).slice(0, 40);
      action.addEventListener("click", () => {
        void sendRuntimeMessage({ type: "TOAST_ACTION", action: message.action });
        host.remove();
      });
      actions.append(action);
    }
    const dismiss = document.createElement("button");
    dismiss.className = "quiet";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => host.remove());
    actions.append(dismiss);
    toast.append(brand, text, actions);
    shadow.append(style, toast);
    (fullscreenRoot || document.documentElement).append(host);
    lastToastAt = now;
    setTimeout(() => host.remove(), 15_000);
    return true;
  }

  function safeRespond(sendResponse, payload) {
    try { sendResponse(payload); } catch {}
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (disposed) return false;
    if (message?.type === "TRACKING_STATE") {
      refreshEpoch += 1;
      if (refreshRetryTimer !== null) clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
      refreshRetryAttempts = 0;
      setTrackingState(message.enabled);
      safeRespond(sendResponse, { ok: true });
    } else if (message?.type === "REFRESH_TRACKING_STATE") {
      void refreshTrackingState().then(
        (ok) => safeRespond(sendResponse, { ok }),
        () => safeRespond(sendResponse, { ok: false })
      );
      return true;
    } else if (message?.type === "SHOW_TOAST") {
      let shown = false;
      try { shown = showToast(message); } catch {}
      safeRespond(sendResponse, { ok: true, shown });
    } else if (message?.type === "HIDE_TOAST") {
      document.querySelector("#watchwise-toast-host")?.remove();
      safeRespond(sendResponse, { ok: true });
    } else if (message?.type === "SEEK_PLAYER") {
      safeRespond(sendResponse, { ok: seekPlayer(message.playerId, Number(message.seconds)) });
    } else if (message?.type === "CONTENT_HEALTH_PROBE") {
      safeRespond(sendResponse, { ok: true, lifecycle: CONTENT_LIFECYCLE, trackingEnabled });
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  const mutationObserver = new MutationObserver((mutations) => {
    if (!trackingEnabled) return;
    for (const mutation of mutations) for (const node of mutation.addedNodes) if (node instanceof Element) discoverVideos(node);
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  function handleVisibilityChange() {
    if (disposed || !trackingEnabled) return;
    if (document.visibilityState !== "visible") {
      for (const video of trackedVideos) terminateIfActive(video, players.get(video));
    } else {
      for (const video of trackedVideos) {
        const metadata = players.get(video);
        metadata.intersecting = false;
        intersectionObserver.unobserve(video);
        intersectionObserver.observe(video);
      }
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange, { signal: lifecycleAbortController.signal });
  function refreshTrackingState(isRetry = false) {
    if (disposed) return Promise.resolve(false);
    if (!isRetry) {
      if (refreshRetryTimer !== null) clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
      refreshRetryAttempts = 0;
    }
    const requestEpoch = ++refreshEpoch;
    return sendRuntimeMessage({ type: "CONTENT_READY", url: canonicalURL() }).then((response) => {
      if (disposed || requestEpoch !== refreshEpoch) return false;
      if (response?.ok !== true) {
        setTrackingState(false);
        if (!disposed && refreshRetryTimer === null && refreshRetryAttempts < MAX_REFRESH_RETRIES) {
          const delay = REFRESH_RETRY_MS * (2 ** refreshRetryAttempts);
          refreshRetryAttempts += 1;
          refreshRetryTimer = setTimeout(() => {
            refreshRetryTimer = null;
            if (!disposed) void refreshTrackingState(true);
          }, delay);
        }
        return false;
      }
      if (refreshRetryTimer !== null) clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
      refreshRetryAttempts = 0;
      setTrackingState(response.enabled === true);
      return true;
    });
  }

  async function probe() {
    if (disposed) return false;
    try {
      const response = await sendRuntimeMessage({ type: "CONTENT_HEALTH_CHECK", lifecycle: CONTENT_LIFECYCLE });
      return response?.ok === true && response.lifecycle === CONTENT_LIFECYCLE;
    } catch { return false; }
  }

  function deactivateLifecycle(preserveFinalInterval = true) {
    if (disposed || deactivating) return;
    deactivating = true;
    // A graceful version replacement preserves the final active interval. An
    // invalidated runtime cannot deliver it, so mark disposed first and clear
    // resources without recursively attempting another send.
    if (!preserveFinalInterval) {
      trackingEnabled = false;
      disposed = true;
    }
    try { stopTracking(preserveFinalInterval); } catch {}
    trackingEnabled = false;
    disposed = true;
    refreshEpoch += 1;
    try { lifecycleAbortController.abort(); } catch {}
    try { intersectionObserver.disconnect(); } catch {}
    try { mutationObserver.disconnect(); } catch {}
    if (refreshRetryTimer !== null) clearTimeout(refreshRetryTimer);
    refreshRetryTimer = null;
    refreshRetryAttempts = 0;
    try { chrome.runtime.onMessage.removeListener?.(handleRuntimeMessage); } catch {}
    try { document.querySelector("#watchwise-toast-host")?.remove(); } catch {}
    deactivating = false;
  }

  const controller = Object.freeze({
    lifecycle: CONTENT_LIFECYCLE,
    probe,
    refresh: refreshTrackingState,
    deactivate: deactivateLifecycle,
    isDisposed: () => disposed,
    isTrackingEnabled: () => trackingEnabled
  });
  if (globalThis[CONTROLLER_KEY] !== startupClaim) {
    deactivateLifecycle();
    return;
  }
  globalThis[CONTROLLER_KEY] = controller;
  refreshTrackingState();
})().catch(() => {});
