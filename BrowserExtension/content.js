(() => {
  "use strict";
  const api = globalThis.browser ?? globalThis.chrome;
  const HEARTBEAT_MS = 15000;
  const MIN_EVENT_GAP_MS = 4000;
  const MIN_VISIBLE_AREA = 120 * 80;
  let trackingEnabled = false;
  let currentVideo = null;
  let lastEventAt = 0;
  let lastURL = "";
  let lastSource = "";
  let playerID = crypto.randomUUID();
  const observedVideos = new WeakSet();
  const intersectingVideos = new WeakMap();

  // IntersectionObserver accounts for clipping by embedding frames, unlike a
  // frame-local bounding rectangle alone. This avoids counting an autoplaying
  // iframe that is outside the top-level page's visible viewport.
  const intersectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      intersectingVideos.set(entry.target, entry.isIntersecting && entry.intersectionRatio > 0);
    }
    discover();
  }, { threshold: [0, 0.01] });

  // Keep paths for distinct posts and episodes; discard query strings that
  // commonly contain search terms, access tokens, or tracking identifiers.
  function canonicalVideoURL() {
    const url = new URL(location.href);
    const youtubeID = /(^|\.)youtube\.com$/.test(url.hostname) ? url.searchParams.get("v") : null;
    url.search = youtubeID ? `?v=${encodeURIComponent(youtubeID)}` : "";
    url.hash = "";
    return url.toString().slice(0, 2048);
  }

  function visibleArea(video) {
    if (!video.isConnected) return 0;
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function stateFor(video, reason) {
    if (reason === "seeking") return "seeking";
    if (video.ended || reason === "ended") return "ended";
    return video.paused ? "paused" : (reason === "heartbeat" ? "heartbeat" : "playing");
  }

  function report(video, reason, force = false) {
    if (!trackingEnabled || !video || document.visibilityState !== "visible") return;
    if (intersectingVideos.get(video) !== true) return;
    const state = stateFor(video, reason);
    if ((state === "playing" || state === "heartbeat") && visibleArea(video) < MIN_VISIBLE_AREA) return;
    const now = Date.now();
    if (!force && now - lastEventAt < MIN_EVENT_GAP_MS) return;
    const duration = Number(video.duration);
    const position = Number(video.currentTime);
    const playbackRate = Number(video.playbackRate);
    if (![duration, position, playbackRate].every(Number.isFinite) || duration <= 0 || duration > 7 * 24 * 3600) return;
    const url = canonicalVideoURL();
    const source = video.currentSrc || video.src || "";
    if (url !== lastURL || source !== lastSource) {
      playerID = crypto.randomUUID();
      lastURL = url;
      lastSource = source;
    }
    lastEventAt = now;
    api.runtime.sendMessage({
      kind: "watchwise.playback",
      payload: {
        schemaVersion: 1,
        title: String(document.title || "Untitled video").trim().slice(0, 512),
        url,
        site: location.hostname.toLowerCase(),
        duration,
        position,
        playbackRate,
        state,
        occurredAtMilliseconds: now,
        documentVisible: true,
        playerID
      }
    }).catch(() => {});
  }

  function discover() {
    if (!trackingEnabled) {
      currentVideo = null;
      return;
    }
    const videos = [...document.querySelectorAll("video")];
    for (const video of videos) {
      if (!observedVideos.has(video)) {
        observedVideos.add(video);
        intersectionObserver.observe(video);
      }
    }
    const candidates = videos
      .filter(video => intersectingVideos.get(video) === true && visibleArea(video) >= MIN_VISIBLE_AREA)
      .sort((a, b) => visibleArea(b) - visibleArea(a));
    const best = candidates.find(video => !video.paused && !video.ended) ?? candidates[0] ?? null;
    if (best === currentVideo) return;
    currentVideo = best;
    lastEventAt = 0;
    playerID = crypto.randomUUID();
    lastSource = "";
    if (best && !best.paused && !best.ended) report(best, "playing", true);
  }

  // Delegated listeners also catch video nodes inserted by infinite feeds.
  for (const eventName of ["play", "pause", "seeking", "ended", "ratechange", "loadedmetadata"]) {
    document.addEventListener(eventName, event => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      if (event.target === currentVideo && (eventName === "pause" || eventName === "ended" || eventName === "seeking")) {
        report(currentVideo, eventName, true);
      }
      discover();
      if (event.target === currentVideo && eventName !== "pause" && eventName !== "ended" && eventName !== "seeking") {
        report(currentVideo, eventName, true);
      }
    }, true);
  }

  let discoveryPending = false;
  new MutationObserver(() => {
    if (discoveryPending) return;
    discoveryPending = true;
    setTimeout(() => { discoveryPending = false; discover(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      discover();
      if (currentVideo) report(currentVideo, "heartbeat", true);
    }
  });
  setInterval(() => {
    discover();
    if (currentVideo && !currentVideo.paused && !currentVideo.ended) report(currentVideo, "heartbeat");
  }, HEARTBEAT_MS);

  api.storage.local.get(["trackingEnabled"]).then(settings => {
    trackingEnabled = settings.trackingEnabled === true;
    if (trackingEnabled) discover();
  }).catch(() => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.trackingEnabled) return;
    trackingEnabled = changes.trackingEnabled.newValue === true;
    if (!trackingEnabled) {
      currentVideo = null;
      lastURL = "";
      lastSource = "";
      playerID = crypto.randomUUID();
      return;
    }
    discover();
  });
})();
