import {
  FACT_CHECK_CAVEAT,
  InMemoryRepository,
  IndexedDBRepository,
  NudgeEngine,
  activeSessionSeconds,
  ProviderProtocolError,
  analysisResultFromInteraction,
  aiEvidenceFromResult,
  automaticAnalysisEligibility,
  automaticSubmissionEligibility,
  buildInteractionRequest,
  classifyHTTPFailure,
  classifyInteractionFailure,
  classifyNetworkFailure,
  createInteraction,
  createWithBackgroundFallback,
  createAnalysisJob,
  completeGoalCheckInReservation,
  dayWindow,
  distinctSessionsInWindow,
  deliverGoalCheckIn,
  evaluateGoalCheckIn,
  failGoalCheckInReservation,
  GOAL_CHECKIN_MESSAGE,
  GOAL_CHECKIN_MIN_GAP_MS,
  meaningfulGoalPlaybackSeconds,
  normalizeSettings,
  interactionDisposition,
  interactionID,
  isGoalPlaybackActive,
  isUnidentifiedYouTubeURL,
  modelOutputText,
  restartAction,
  safeSettingsExport,
  shouldAcceptAnalysisJobUpdate,
  summarizeViewing,
  transitionAnalysisJob,
  validateAnalysisJob,
  validateAnalysisResult,
  validatePlaybackEvent,
  weekWindow,
  youtubeVideoIdentity
} from "../lib/index.js";

let passed = 0;
const failures = [];

function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message = "values differ") {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function near(actual, expected, tolerance = 0.0001, message = "values differ") {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function throws(fn, message = "expected error") {
  let didThrow = false;
  try { fn(); } catch { didThrow = true; }
  if (!didThrow) throw new Error(message);
}
async function rejects(fn, expectedCode, message = "expected rejection") {
  try { await fn(); }
  catch (error) {
    if (expectedCode && error?.code !== expectedCode) throw new Error(`${message}: expected ${expectedCode}, got ${error?.code}`);
    return;
  }
  throw new Error(message);
}
async function test(name, fn) {
  try { await fn(); passed += 1; print(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); print(`FAIL ${name}: ${error.message}`); }
}

const BASE = 1_800_000_000_000;
await test("supported YouTube URL forms share one canonical video identity", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/embed/abc",
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/live/abc",
    "https://youtu.be/abc"
  ]) equal(youtubeVideoIdentity(url)?.videoKey, "youtube:abc");
});
await test("unidentified YouTube preview detection is exact-host and preserves canonical videos", () => {
  for (const url of [
    "https://youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://m.youtube.com/watch?feature=autoplay",
    "https://youtu.be/"
  ]) equal(isUnidentifiedYouTubeURL(url), true);
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/embed/abc",
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/live/abc",
    "https://youtu.be/abc",
    "https://notyoutube.com/",
    "https://youtube.com.example.com/feed",
    "https://feed.example/"
  ]) equal(isUnidentifiedYouTubeURL(url), false);
});
function rawEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventID: "event-1",
    sessionID: "session-1",
    playerID: "player-1",
    tabID: 4,
    frameID: 0,
    frameSite: "www.youtube.com",
    pageSite: "www.youtube.com",
    url: "https://www.youtube.com/watch?v=abc&utm_source=test#comments",
    mediaTitle: "  Useful   explanation  ",
    durationSeconds: 600,
    positionSeconds: 0,
    playbackRate: 1,
    state: "playing",
    occurredAtMs: BASE,
    isVisible: true,
    isTabActive: true,
    ...overrides
  };
}
function event(overrides = {}) { return validatePlaybackEvent(rawEvent(overrides)); }
function successfulResult(overrides = {}) {
  return {
    schemaVersion: 1,
    jobID: "job-1",
    summary: "The central explanation starts after a repeated introduction.",
    keyPoints: [{ seconds: 90, text: "Main explanation" }],
    skipSegments: [{ startSeconds: 0, endSeconds: 75, reason: "Repeated introduction" }],
    verdict: "skim",
    confidence: 0.8,
    evidence: ["The introduction repeats one claim without adding an example."],
    caveat: FACT_CHECK_CAVEAT,
    completedAtMs: BASE + 1000,
    lowInformationSignal: true,
    ...overrides
  };
}
function providerResult(overrides = {}) {
  return {
    summary: "The central explanation starts after a repeated introduction.",
    keyPoints: [{ seconds: 90, text: "Main explanation" }],
    skipSegments: [{ startSeconds: 0, endSeconds: 75, reason: "Repeated introduction" }],
    verdict: "skim",
    confidence: 0.8,
    evidence: ["The introduction repeats one claim without adding an example."],
    caveat: FACT_CHECK_CAVEAT,
    lowInformationSignal: true,
    ...overrides
  };
}

await test("strict playback validation and canonicalization", () => {
  const value = event();
  equal(value.mediaTitle, "Useful explanation");
  equal(value.url, "https://www.youtube.com/watch?v=abc");
  const vimeo = event({
    eventID: "vimeo-1",
    frameSite: "vimeo.com",
    pageSite: "vimeo.com",
    url: "https://vimeo.com/12345?autoplay=1&private_token=nope#details"
  });
  equal(vimeo.url, "https://vimeo.com/12345");
  const unknown = rawEvent(); unknown.pageText = "must not enter storage";
  throws(() => validatePlaybackEvent(unknown));
  throws(() => event({ pageSite: "localhost" }));
  throws(() => event({ url: "https://attacker.example/video" }));
  throws(() => event({ url: "https://user:secret@www.youtube.com/watch?v=abc" }));
});

await test("overlapping players are unioned for wall time and additive for content", () => {
  const events = [
    event({ eventID: "a1", sessionID: "sa", playerID: "pa", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "a2", sessionID: "sa", playerID: "pa", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" }),
    event({ eventID: "b1", sessionID: "sb", playerID: "pb", frameID: 2, url: "https://www.youtube.com/watch?v=def", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "b2", sessionID: "sb", playerID: "pb", frameID: 2, url: "https://www.youtube.com/watch?v=def", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "ended" })
  ];
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 });
  near(insight.activeSeconds, 10);
  near(insight.contentSeconds, 20);
  equal(insight.videosStarted, 2);
  equal(insight.videosCompleted, 1);
  equal(insight.sites.length, 1);
  near(insight.sites[0].activeSeconds, 10);
  equal(insight.sites[0].videosStarted, 2);
});

await test("overlapping watch and embed players for one canonical video count once", () => {
  const events = [
    event({ eventID: "same-a1", sessionID: "same-a", playerID: "same-pa", url: "https://www.youtube.com/watch?v=same", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "same-a2", sessionID: "same-a", playerID: "same-pa", url: "https://www.youtube.com/watch?v=same", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" }),
    event({ eventID: "same-b1", sessionID: "same-b", playerID: "same-pb", frameID: 2, url: "https://www.youtube.com/embed/same", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "same-b2", sessionID: "same-b", playerID: "same-pb", frameID: 2, url: "https://www.youtube.com/embed/same", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" })
  ];
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 });
  equal(insight.videosStarted, 1);
  equal(insight.videos.length, 1);
  near(insight.activeSeconds, 10);
  near(insight.contentSeconds, 20);
});

await test("player and session boundaries never create synthetic viewing", () => {
  const events = [
    event({ eventID: "x1", sessionID: "s1", playerID: "same", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "x2", sessionID: "s2", playerID: "same", occurredAtMs: BASE + 10_000, positionSeconds: 100, state: "paused" })
  ];
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 });
  equal(insight.activeSeconds, 0);
  equal(insight.contentSeconds, 0);
  equal(insight.videosStarted, 0);
});

await test("paused metadata and player churn do not count as video starts", () => {
  const events = Array.from({ length: 17 }, (_, index) => event({
    eventID: `preview-${index}`,
    sessionID: `preview-session-${index}`,
    playerID: `preview-player-${index}`,
    occurredAtMs: BASE + index,
    state: "paused",
    positionSeconds: 0
  }));
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 60_000 });
  equal(insight.videosStarted, 0);
});

await test("three meaningful watched sessions count as three starts", () => {
  const events = [];
  for (let index = 0; index < 3; index += 1) {
    const start = BASE + index * 20_000;
    events.push(event({ eventID: `watch-${index}-a`, sessionID: `watch-${index}`, playerID: `player-${index}`, occurredAtMs: start, positionSeconds: 0 }));
    events.push(event({ eventID: `watch-${index}-b`, sessionID: `watch-${index}`, playerID: `player-${index}`, occurredAtMs: start + 5_000, positionSeconds: 5, state: "paused" }));
  }
  equal(summarizeViewing(events, { startMs: BASE, endMs: BASE + 80_000 }).videosStarted, 3);
});

await test("near-contiguous DOM replacement at resumed position is one start", () => {
  const events = [
    event({ eventID: "dom-a1", sessionID: "dom-a", playerID: "element-a", occurredAtMs: BASE, positionSeconds: 10 }),
    event({ eventID: "dom-a2", sessionID: "dom-a", playerID: "element-a", occurredAtMs: BASE + 5_000, positionSeconds: 15, state: "paused" }),
    event({ eventID: "dom-b1", sessionID: "dom-b", playerID: "element-b", occurredAtMs: BASE + 6_000, positionSeconds: 15 }),
    event({ eventID: "dom-b2", sessionID: "dom-b", playerID: "element-b", occurredAtMs: BASE + 11_000, positionSeconds: 20, state: "paused" })
  ];
  equal(summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 }).videosStarted, 1);
});

await test("after history reset, overlapping DOM players for one YouTube Short count once and keep a breakdown row", () => {
  const events = [];
  for (let index = 0; index < 4; index += 1) {
    const start = BASE + index * 100;
    const shared = {
      sessionID: `short-session-${index}`,
      playerID: `short-player-${index}`,
      frameID: index,
      url: "https://www.youtube.com/shorts/short-one",
      mediaTitle: "One useful Short"
    };
    events.push(event({ ...shared, eventID: `short-${index}-start`, occurredAtMs: start, positionSeconds: 0 }));
    events.push(event({ ...shared, eventID: `short-${index}-end`, occurredAtMs: start + 5_000, positionSeconds: 5, state: "paused" }));
  }
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 });
  equal(insight.videosStarted, 1);
  equal(insight.videos.length, 1);
  assert(!(insight.videosStarted > 0) || insight.videos.length > 0, "A counted Short start must have a breakdown row");
  equal(insight.videos[0].url, "https://www.youtube.com/watch?v=short-one");
  assert(insight.videos[0].activeSeconds > 0, "Short breakdown row lost its watched time");
});

await test("near-zero Short replacement dedupes but a later replay remains a new start", () => {
  const firstAndReplacement = [
    event({ eventID: "short-zero-a1", sessionID: "short-zero-a", playerID: "short-zero-pa", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "short-zero-a2", sessionID: "short-zero-a", playerID: "short-zero-pa", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE + 5_000, positionSeconds: 5, state: "paused" }),
    event({ eventID: "short-zero-b1", sessionID: "short-zero-b", playerID: "short-zero-pb", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE + 6_000, positionSeconds: 0 }),
    event({ eventID: "short-zero-b2", sessionID: "short-zero-b", playerID: "short-zero-pb", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE + 11_000, positionSeconds: 5, state: "paused" })
  ];
  equal(summarizeViewing(firstAndReplacement, { startMs: BASE, endMs: BASE + 80_000 }).videosStarted, 1);
  const withLaterReplay = firstAndReplacement.concat([
    event({ eventID: "short-zero-c1", sessionID: "short-zero-c", playerID: "short-zero-pc", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE + 20_000, positionSeconds: 0 }),
    event({ eventID: "short-zero-c2", sessionID: "short-zero-c", playerID: "short-zero-pc", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE + 25_000, positionSeconds: 5, state: "paused" })
  ]);
  equal(summarizeViewing(withLaterReplay, { startMs: BASE, endMs: BASE + 80_000 }).videosStarted, 2);
});

await test("three YouTube homepage previews plus one Short produce only the Short insight", () => {
  const events = [
    event({ eventID: "home-a1", sessionID: "home-a", playerID: "home-player-a", occurredAtMs: BASE, positionSeconds: 0, url: "https://www.youtube.com/" }),
    event({ eventID: "home-a2", sessionID: "home-a", playerID: "home-player-a", occurredAtMs: BASE + 5_000, positionSeconds: 5, state: "paused", url: "https://www.youtube.com/" }),
    event({ eventID: "home-b1", sessionID: "home-b", playerID: "home-player-b", occurredAtMs: BASE + 6_000, positionSeconds: 0, url: "https://www.youtube.com/" }),
    event({ eventID: "home-b2", sessionID: "home-b", playerID: "home-player-b", occurredAtMs: BASE + 11_000, positionSeconds: 5, state: "paused", url: "https://www.youtube.com/" }),
    event({ eventID: "home-c1", sessionID: "home-c", playerID: "home-player-c", occurredAtMs: BASE + 12_000, positionSeconds: 0, url: "https://www.youtube.com/" }),
    event({ eventID: "home-c2", sessionID: "home-c", playerID: "home-player-c", occurredAtMs: BASE + 17_000, positionSeconds: 5, state: "paused", url: "https://www.youtube.com/" }),
    event({ eventID: "real-short-1", sessionID: "real-short", playerID: "real-short-player", occurredAtMs: BASE + 20_000, positionSeconds: 0, url: "https://www.youtube.com/shorts/real-short", mediaTitle: "Real Short" }),
    event({ eventID: "real-short-2", sessionID: "real-short", playerID: "real-short-player", occurredAtMs: BASE + 25_000, positionSeconds: 5, state: "paused", url: "https://www.youtube.com/shorts/real-short", mediaTitle: "Real Short" })
  ];
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 30_000 });
  equal(insight.videosStarted, 1);
  near(insight.activeSeconds, 5);
  near(insight.contentSeconds, 5);
  equal(insight.sites.length, 1);
  near(insight.sites[0].activeSeconds, 5);
  equal(insight.videos.length, 1);
  equal(insight.videos[0].title, "Real Short");
  near(insight.videos[0].activeSeconds, 5);
  equal(insight.videos[0].url, "https://www.youtube.com/watch?v=real-short");
});

await test("video breakdown dedupes YouTube identity and preserves title link site and sorting", () => {
  const events = [
    event({ eventID: "yt-a1", sessionID: "yt-a", playerID: "yt-pa", mediaTitle: "  Main   lesson  ", url: "https://www.youtube.com/watch?v=abc&utm_source=x", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "yt-a2", sessionID: "yt-a", playerID: "yt-pa", mediaTitle: "Main lesson", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE + 6_000, positionSeconds: 6, state: "paused" }),
    event({ eventID: "yt-b1", sessionID: "yt-b", playerID: "yt-pb", mediaTitle: "Main lesson", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE + 7_000, positionSeconds: 6 }),
    event({ eventID: "yt-b2", sessionID: "yt-b", playerID: "yt-pb", mediaTitle: "Main lesson", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE + 11_000, positionSeconds: 10, state: "paused" }),
    event({ eventID: "other-1", sessionID: "other", playerID: "other", mediaTitle: "Short item", url: "https://video.example/watch", frameSite: "video.example", pageSite: "video.example", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "other-2", sessionID: "other", playerID: "other", mediaTitle: "Short item", url: "https://video.example/watch", frameSite: "video.example", pageSite: "video.example", occurredAtMs: BASE + 4_000, positionSeconds: 4, state: "paused" })
  ];
  const videos = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 }).videos;
  equal(videos.length, 2);
  equal(videos[0].title, "Main lesson");
  equal(videos[0].url, "https://www.youtube.com/watch?v=abc");
  equal(videos[0].site, "www.youtube.com");
  near(videos[0].activeSeconds, 8);
  assert(videos[0].activeSeconds > videos[1].activeSeconds);
});

await test("Netflix player title replaces generic Netflix brand within a session", () => {
  const netflix = {
    sessionID: "netflix-session", playerID: "netflix-player",
    url: "https://www.netflix.com/watch/12345",
    frameSite: "www.netflix.com", pageSite: "www.netflix.com"
  };
  const events = [
    event({ ...netflix, eventID: "nf1", mediaTitle: "Netflix", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ ...netflix, eventID: "nf2", mediaTitle: "Dark", occurredAtMs: BASE + 5_000, positionSeconds: 5, state: "heartbeat" }),
    event({ ...netflix, eventID: "nf3", mediaTitle: "Dark", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" })
  ];
  const videos = summarizeViewing(events, { startMs: BASE, endMs: BASE + 15_000 }).videos;
  equal(videos.length, 1);
  equal(videos[0].title, "Dark");
  equal(videos[0].url, "https://www.netflix.com/watch/12345");
  near(videos[0].activeSeconds, 10);
});

await test("generic feed sessions stay distinct and per-video overlap is additive", () => {
  const events = [
    event({ eventID: "ga1", sessionID: "ga", playerID: "ga", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "ga2", sessionID: "ga", playerID: "ga", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" }),
    event({ eventID: "gb1", sessionID: "gb", playerID: "gb", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE, positionSeconds: 0 }),
    event({ eventID: "gb2", sessionID: "gb", playerID: "gb", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE + 10_000, positionSeconds: 10, state: "paused" })
  ];
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 20_000 });
  equal(insight.videos.length, 2);
  near(insight.activeSeconds, 10);
  near(insight.videos.reduce((sum, video) => sum + video.activeSeconds, 0), 10);
});

await test("recovered reused-player SPA transitions advance an existing six-start/four-minute dashboard", () => {
  const events = [];
  for (let index = 0; index < 6; index += 1) {
    const start = BASE + index * 41_000;
    const shared = { sessionID: `existing-${index}`, playerID: "reused-youtube-player", url: `https://www.youtube.com/watch?v=existing-${index}`, mediaTitle: `Existing ${index}` };
    events.push(event({ ...shared, eventID: `existing-${index}-start`, occurredAtMs: start, positionSeconds: 0 }));
    events.push(event({ ...shared, eventID: `existing-${index}-end`, occurredAtMs: start + 40_000, positionSeconds: 40, state: "paused" }));
  }
  [
    "https://www.youtube.com/watch?v=recent-watch-a",
    "https://www.youtube.com/shorts/recent-short-b",
    "https://www.youtube.com/watch?v=recent-watch-c",
    "https://www.youtube.com/shorts/recent-short-d"
  ].forEach((url, index) => {
    const start = BASE + 250_000 + index * 11_000;
    const shared = { sessionID: `recent-${index}`, playerID: "reused-youtube-player", url, mediaTitle: `Recent ${index}` };
    events.push(event({ ...shared, eventID: `recent-${index}-start`, occurredAtMs: start, positionSeconds: 0 }));
    events.push(event({ ...shared, eventID: `recent-${index}-end`, occurredAtMs: start + 10_000, positionSeconds: 10, state: "paused" }));
  });
  const insight = summarizeViewing(events, { startMs: BASE, endMs: BASE + 310_000 });
  equal(insight.videosStarted, 10);
  near(insight.activeSeconds, 280);
  equal(insight.videos.length, 10);
});

await test("daily and weekly windows honor deterministic timezone offset", () => {
  const day = dayWindow(BASE, 330);
  equal(day.endMs - day.startMs, 86_400_000);
  assert(BASE >= day.startMs && BASE < day.endMs);
  const week = weekWindow(BASE, 330, 1);
  equal(week.endMs - week.startMs, 7 * 86_400_000);
  assert(BASE >= week.startMs && BASE < week.endMs);
});

await test("settings default off and exports omit unknown secrets", () => {
  const defaults = normalizeSettings();
  equal(defaults.trackingEnabled, false);
  equal(defaults.notificationsEnabled, false);
  equal(defaults.aiEnabled, false);
  equal(defaults.autoAnalysisEnabled, true);
  const preConsentOptOut = normalizeSettings({ aiEnabled: false, autoAnalysisEnabled: false });
  equal(preConsentOptOut.aiEnabled, false);
  equal(preConsentOptOut.autoAnalysisEnabled, false);
  const exported = safeSettingsExport({ trackingEnabled: true, geminiApiKey: "secret", excludedSites: ["YouTube.com"] });
  equal(exported.excludedSites[0], "youtube.com");
  assert(!("geminiApiKey" in exported));
  assert(!JSON.stringify(exported).includes("secret"));
});

await test("automatic YouTube eligibility requires active playback, consent, key, and privacy allowance", () => {
  const active = event();
  const settings = { trackingEnabled: true, aiEnabled: true, autoAnalysisEnabled: true };
  const base = { event: active, settings, apiKeyConfigured: true, existingJobs: [], activeWatchedSeconds: 3, nowMs: BASE };
  const eligible = automaticAnalysisEligibility(base);
  equal(eligible.eligible, true);
  equal(eligible.videoKey, "youtube:abc");
  equal(eligible.canonicalURL, "https://www.youtube.com/watch?v=abc");
  equal(automaticAnalysisEligibility({ ...base, settings: { ...settings, aiEnabled: false } }).reason, "ai_consent_off");
  equal(automaticAnalysisEligibility({ ...base, settings: { ...settings, autoAnalysisEnabled: false } }).reason, "automatic_off");
  equal(automaticAnalysisEligibility({ ...base, apiKeyConfigured: false }).reason, "key_missing");
  equal(automaticAnalysisEligibility({ ...base, settings: { ...settings, movieModeUntilMs: BASE + 1000 } }).reason, "movie_mode");
  equal(automaticAnalysisEligibility({ ...base, settings: { ...settings, excludedSites: ["youtube.com"] } }).reason, "site_excluded");
  equal(automaticAnalysisEligibility({ ...base, event: event({ state: "paused" }) }).reason, "inactive_playback");
  equal(automaticAnalysisEligibility({ ...base, event: event({ isVisible: false }) }).reason, "inactive_playback");
  equal(automaticAnalysisEligibility({ ...base, event: event({ isTabActive: false }) }).reason, "inactive_playback");
  const vimeo = event({ eventID: "vimeo-auto", frameSite: "vimeo.com", pageSite: "vimeo.com", url: "https://vimeo.com/123" });
  equal(automaticAnalysisEligibility({ ...base, event: vimeo }).reason, "not_public_youtube");
});

await test("automatic analysis rejects previews and triggers from meaningful heartbeat progress", () => {
  const settings = { trackingEnabled: true, aiEnabled: true, autoAnalysisEnabled: true };
  equal(automaticAnalysisEligibility({ event: event(), settings, apiKeyConfigured: true, activeWatchedSeconds: 0 }).reason, "insufficient_progress");
  equal(automaticAnalysisEligibility({ event: event(), settings, apiKeyConfigured: true, activeWatchedSeconds: 2.99 }).reason, "insufficient_progress");
  const heartbeat = automaticAnalysisEligibility({ event: event({ state: "heartbeat" }), settings, apiKeyConfigured: true, activeWatchedSeconds: 3 });
  equal(heartbeat.eligible, true);
});

await test("automatic identity deduplicates URL forms and every persisted job status", () => {
  equal(youtubeVideoIdentity("https://youtu.be/abc")?.videoKey, "youtube:abc");
  equal(youtubeVideoIdentity("https://www.youtube.com/embed/abc?autoplay=1")?.videoKey, "youtube:abc");
  equal(youtubeVideoIdentity("https://www.youtube.com/shorts/abc")?.videoKey, "youtube:abc");
  const settings = { trackingEnabled: true, aiEnabled: true, autoAnalysisEnabled: true };
  const failed = transitionAnalysisJob(
    createAnalysisJob({ jobID: "auto-existing", url: "https://youtu.be/abc", mediaTitle: "Video", origin: "automatic", nowMs: BASE }),
    "failed",
    { errorCode: "provider_failed" },
    BASE + 1
  );
  const decision = automaticAnalysisEligibility({ event: event(), settings, apiKeyConfigured: true, existingJobs: [failed], activeWatchedSeconds: 3, nowMs: BASE + 2 });
  equal(decision.eligible, false);
  equal(decision.reason, "already_requested");
});

await test("automatic dedupe survives repository restart state", async () => {
  const repository = new InMemoryRepository();
  const job = createAnalysisJob({ jobID: "auto-durable", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", origin: "automatic", nowMs: BASE });
  await repository.putAnalysisJob(job);
  const persisted = JSON.parse(JSON.stringify(await repository.listAnalysisJobs()));
  validateAnalysisJob(persisted[0]);
  equal(persisted[0].origin, "automatic");
  equal(restartAction(persisted[0], BASE + 1000), "submit");
  const decision = automaticAnalysisEligibility({
    event: event(),
    settings: { trackingEnabled: true, aiEnabled: true, autoAnalysisEnabled: true },
    apiKeyConfigured: true,
    existingJobs: persisted,
    activeWatchedSeconds: 3,
    nowMs: BASE + 1000
  });
  equal(decision.reason, "already_requested");
});

await test("automatic restart gate rechecks consent, toggle, key, Movie Mode, tracking, and exclusions", () => {
  const job = createAnalysisJob({ jobID: "auto-restart-gates", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", origin: "automatic", nowMs: BASE });
  const settings = { trackingEnabled: true, aiEnabled: true, autoAnalysisEnabled: true };
  const source = { frameSite: "www.youtube.com", pageSite: "example.com" };
  const base = { job, settings, apiKeyConfigured: true, source, nowMs: BASE };
  equal(automaticSubmissionEligibility(base).eligible, true);
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, trackingEnabled: false } }).reason, "tracking_off");
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, aiEnabled: false } }).reason, "ai_consent_off");
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, autoAnalysisEnabled: false } }).reason, "automatic_off");
  equal(automaticSubmissionEligibility({ ...base, apiKeyConfigured: false }).reason, "key_missing");
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, movieModeUntilMs: BASE + 1 } }).reason, "movie_mode");
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, excludedSites: ["example.com"] } }).reason, "site_excluded");
  equal(automaticSubmissionEligibility({ ...base, settings: { ...settings, excludedSites: ["youtube.com"] } }).reason, "site_excluded");
});

await test("all nudge suppression controls are enforced", () => {
  const baseSettings = { trackingEnabled: true, notificationsEnabled: true };
  const context = { nowMs: BASE, pageSite: "youtube.com", dailyActiveSeconds: 4000, activeSessionSeconds: 2000, distinctSessionsLast20Minutes: 6, playbackRate: 1, positionSeconds: 10 };
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, trackingEnabled: false }).suppression, "tracking_off");
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, notificationsEnabled: false }).suppression, "notifications_off");
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, excludedSites: ["youtube.com"] }).suppression, "site_excluded");
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, movieModeUntilMs: BASE + 1 }).suppression, "movie_mode");
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, snoozedUntilMs: BASE + 1 }).suppression, "snoozed");
  const localMinute = new Date(BASE).getUTCHours() * 60 + new Date(BASE).getUTCMinutes();
  equal(new NudgeEngine().evaluate(context, { ...baseSettings, quietHoursEnabled: true, quietHoursStartMinute: localMinute, quietHoursEndMinute: (localMinute + 1) % 1440 }, 0).suppression, "quiet_hours");
});

await test("1x playback never triggers slow or skip nudge without AI evidence", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true, dailyLimitSeconds: 5000, longSessionSeconds: 5000 };
  const context = { nowMs: BASE, pageSite: "youtube.com", dailyActiveSeconds: 10, activeSessionSeconds: 10, distinctSessionsLast20Minutes: 1, playbackRate: 1, positionSeconds: 10 };
  equal(new NudgeEngine({ cooldownMs: 0 }).evaluate(context, settings).nudge, null);
  const result = validateAnalysisResult(successfulResult());
  const withEvidence = { ...context, aiEvidence: aiEvidenceFromResult(result, context.positionSeconds) };
  equal(new NudgeEngine({ cooldownMs: 0 }).evaluate(withEvidence, settings).nudge.kind, "skip_to_main_point");
});

await test("nudge cooldown and hourly limit are deterministic", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true, dailyLimitSeconds: 300 };
  const context = { nowMs: BASE, pageSite: "youtube.com", dailyActiveSeconds: 301, activeSessionSeconds: 1, distinctSessionsLast20Minutes: 1, playbackRate: 1, positionSeconds: 1 };
  const engine = new NudgeEngine({ cooldownMs: 600_000, hourlyLimit: 1 });
  assert(engine.evaluate(context, settings).nudge);
  equal(engine.evaluate({ ...context, nowMs: BASE + 60_000 }, settings).suppression, "cooldown");
  equal(engine.evaluate({ ...context, nowMs: BASE + 700_000 }, settings).suppression, "hourly_limit");
});

function goalProgressEvents({ id = "goal", url = "https://www.youtube.com/watch?v=goal", startMs = BASE, seconds = 15, tabID = 4, frameID = 0, sessionID = "goal-session", playerID = "goal-player", frameSite = "www.youtube.com", pageSite = "www.youtube.com" } = {}) {
  const shared = { url, tabID, frameID, sessionID, playerID, frameSite, pageSite, mediaTitle: "Goal video" };
  return [
    event({ ...shared, eventID: `${id}-start`, occurredAtMs: startMs, positionSeconds: 0, state: "playing" }),
    event({ ...shared, eventID: `${id}-progress`, occurredAtMs: startMs + seconds * 1_000, positionSeconds: seconds, state: "heartbeat" })
  ];
}

await test("goal check-in fires at 15 meaningful seconds exactly once", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true };
  const below = goalProgressEvents({ id: "below", seconds: 14.9 });
  const belowDecision = evaluateGoalCheckIn({ events: below, event: below.at(-1), settings, nowMs: BASE + 14_900 });
  equal(belowDecision.shouldPrompt, false);
  equal(belowDecision.suppression, "threshold");
  near(belowDecision.meaningfulSeconds, 14.9);

  const threshold = goalProgressEvents({ id: "threshold", seconds: 15 });
  const first = evaluateGoalCheckIn({ events: threshold, event: threshold.at(-1), settings, state: belowDecision.state, nowMs: BASE + 15_000 });
  equal(first.shouldPrompt, true);
  equal(first.message, GOAL_CHECKIN_MESSAGE);
  equal(first.message, "Hope you’re clear on your goal for watching this video.");
  const completedState = completeGoalCheckInReservation(first.state, first.reservation, BASE + 15_001);
  const restartedState = JSON.parse(JSON.stringify(completedState));
  const repeated = evaluateGoalCheckIn({ events: [...threshold, event({ eventID: "threshold-repeat", sessionID: "goal-session", playerID: "goal-player", url: "https://www.youtube.com/watch?v=goal", mediaTitle: "Goal video", occurredAtMs: BASE + 20_000, positionSeconds: 20, state: "heartbeat" })], event: event({ eventID: "threshold-target", sessionID: "goal-session", playerID: "goal-player", url: "https://www.youtube.com/watch?v=goal", mediaTitle: "Goal video", occurredAtMs: BASE + 20_000, positionSeconds: 20, state: "heartbeat" }), settings, state: restartedState, nowMs: BASE + 20_000 });
  equal(repeated.shouldPrompt, false);
  equal(repeated.suppression, "already_processed");
});

await test("goal check-in suppression crosses the threshold without later backfill", () => {
  const events = goalProgressEvents({ id: "suppressed", url: "https://video.example/watch", sessionID: "suppressed-session", frameSite: "video.example", pageSite: "video.example" });
  const target = events.at(-1);
  const localMinute = new Date(BASE + 15_000).getUTCHours() * 60 + new Date(BASE + 15_000).getUTCMinutes();
  const cases = [
    [{ trackingEnabled: false, notificationsEnabled: true }, "tracking_off"],
    [{ trackingEnabled: true, notificationsEnabled: false }, "notifications_off"],
    [{ trackingEnabled: true, notificationsEnabled: true, movieModeUntilMs: BASE + 60_000 }, "movie_mode"],
    [{ trackingEnabled: true, notificationsEnabled: true, snoozedUntilMs: BASE + 60_000 }, "snoozed"],
    [{ trackingEnabled: true, notificationsEnabled: true, quietHoursEnabled: true, quietHoursStartMinute: localMinute, quietHoursEndMinute: (localMinute + 1) % 1440 }, "quiet_hours"],
    [{ trackingEnabled: true, notificationsEnabled: true, excludedSites: ["video.example"] }, "site_excluded"]
  ];
  for (const [settings, expected] of cases) {
    const suppressed = evaluateGoalCheckIn({ events, event: target, settings, nowMs: BASE + 15_000, offsetMinutes: 0 });
    equal(suppressed.shouldPrompt, false);
    equal(suppressed.suppression, expected);
    const allowedLater = evaluateGoalCheckIn({ events, event: target, settings: { trackingEnabled: true, notificationsEnabled: true }, state: suppressed.state, nowMs: BASE + 120_000 });
    equal(allowedLater.suppression, "already_processed", `${expected} was backfilled later`);
  }
});

await test("goal progress unions replacement frames but not tabs, episodes, or seeks", () => {
  const sameVideo = [
    ...goalProgressEvents({ id: "watch-frame", seconds: 10, url: "https://www.youtube.com/watch?v=shared", sessionID: "watch-frame", playerID: "watch-player" }),
    ...goalProgressEvents({ id: "embed-frame", seconds: 10, url: "https://www.youtube.com/embed/shared", sessionID: "embed-frame", playerID: "embed-player", frameID: 2 }),
    ...goalProgressEvents({ id: "replacement", startMs: BASE + 10_000, seconds: 5, url: "https://www.youtube.com/shorts/shared", sessionID: "replacement", playerID: "replacement-player" })
  ];
  near(meaningfulGoalPlaybackSeconds(sameVideo, sameVideo.at(-1)), 15);

  const otherTab = goalProgressEvents({ id: "other-tab", seconds: 10, url: "https://www.youtube.com/watch?v=shared", tabID: 8, sessionID: "other-tab" });
  near(meaningfulGoalPlaybackSeconds([...sameVideo.slice(0, 2), ...otherTab], otherTab.at(-1)), 10);

  const laterEpisode = goalProgressEvents({ id: "later", seconds: 10, url: "https://www.youtube.com/watch?v=shared", startMs: BASE + 5 * 60_000, sessionID: "later" });
  near(meaningfulGoalPlaybackSeconds([...sameVideo.slice(0, 2), ...laterEpisode], laterEpisode.at(-1)), 10);
  const newStartOnly = event({ eventID: "new-start-only", sessionID: "new-start-only", playerID: "new-start-only", url: "https://www.youtube.com/watch?v=shared", occurredAtMs: BASE + 5 * 60_000, positionSeconds: 0, state: "playing" });
  near(meaningfulGoalPlaybackSeconds([...sameVideo.slice(0, 2), newStartOnly], newStartOnly), 0);

  const seek = [event({ eventID: "seek-a", sessionID: "seek", playerID: "seek", occurredAtMs: BASE, positionSeconds: 0 }), event({ eventID: "seek-b", sessionID: "seek", playerID: "seek", occurredAtMs: BASE + 1_000, positionSeconds: 300, state: "heartbeat" })];
  near(meaningfulGoalPlaybackSeconds(seek, seek.at(-1)), 0);
  for (const [label, overrides] of [["paused", { state: "paused" }], ["seeking", { state: "seeking" }], ["hidden", { isVisible: false }], ["inactive", { isTabActive: false }]]) {
    const pair = [event({ eventID: `${label}-a`, sessionID: label, playerID: label, occurredAtMs: BASE, positionSeconds: 0, ...overrides }), event({ eventID: `${label}-b`, sessionID: label, playerID: label, occurredAtMs: BASE + 20_000, positionSeconds: 20, state: "heartbeat" })];
    near(meaningfulGoalPlaybackSeconds(pair, pair.at(-1)), 0, 0.0001, `${label} playback counted toward goal threshold`);
  }
});

await test("goal delivery requires the reserved stream to remain active and visible", () => {
  const active = goalProgressEvents({ id: "active-delivery", seconds: 15 });
  equal(isGoalPlaybackActive(active, active.at(-1), BASE + 15_000), true);
  const paused = event({ ...active.at(-1), eventID: "active-delivery-paused", occurredAtMs: BASE + 16_000, positionSeconds: 16, state: "paused" });
  equal(isGoalPlaybackActive([...active, paused], active.at(-1), BASE + 16_000), false);
  const hidden = event({ ...active.at(-1), eventID: "active-delivery-hidden", occurredAtMs: BASE + 16_000, positionSeconds: 16, state: "heartbeat", isVisible: false });
  equal(isGoalPlaybackActive([...active, hidden], active.at(-1), BASE + 16_000), false);
  equal(isGoalPlaybackActive(active, active.at(-1), BASE + 46_000), false);

  const successorPause = event({ ...active.at(-1), eventID: "active-successor-pause", sessionID: "successor", playerID: "successor", occurredAtMs: BASE + 16_000, positionSeconds: 16, state: "paused" });
  equal(isGoalPlaybackActive([...active, successorPause], active.at(-1), BASE + 16_000), false);
  const successorHidden = event({ ...successorPause, eventID: "active-successor-hidden", occurredAtMs: BASE + 17_000, state: "heartbeat", isVisible: false });
  equal(isGoalPlaybackActive([...active, successorHidden], active.at(-1), BASE + 17_000), false);
  const originalReclaims = event({ ...active.at(-1), eventID: "active-original-reclaims", occurredAtMs: BASE + 18_000, positionSeconds: 18, state: "heartbeat" });
  equal(isGoalPlaybackActive([...active, successorHidden, originalReclaims], active.at(-1), BASE + 18_000), true);

  const genericTarget = event({ eventID: "generic-active", sessionID: "generic-active", playerID: "generic-active", url: "https://video.example/watch", frameSite: "video.example", pageSite: "video.example", occurredAtMs: BASE, positionSeconds: 0 });
  const unrelatedGeneric = event({ ...genericTarget, eventID: "generic-other", sessionID: "generic-other", playerID: "generic-other", occurredAtMs: BASE + 1_000, state: "paused" });
  equal(isGoalPlaybackActive([genericTarget, unrelatedGeneric], genericTarget, BASE + 1_000), true);
});

await test("goal cadence keeps a distinct active video pending until the brief gap", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true };
  const firstEvents = goalProgressEvents({ id: "first-goal", url: "https://www.youtube.com/watch?v=first-goal", sessionID: "first-goal" });
  const first = evaluateGoalCheckIn({ events: firstEvents, event: firstEvents.at(-1), settings, nowMs: BASE + 15_000 });
  assert(first.shouldPrompt);
  const firstCompleted = completeGoalCheckInReservation(first.state, first.reservation, BASE + 15_001);

  const secondEvents = goalProgressEvents({ id: "second-goal", url: "https://www.youtube.com/watch?v=second-goal", sessionID: "second-goal", startMs: BASE + 30_000 });
  const pending = evaluateGoalCheckIn({ events: secondEvents, event: secondEvents.at(-1), settings, state: firstCompleted, nowMs: BASE + 45_000 });
  equal(pending.shouldPrompt, false);
  equal(pending.suppression, "cadence");
  equal(pending.state.processed.some((entry) => entry.identity === "youtube:second-goal"), false);

  const stillActive = event({ eventID: "second-still-active", sessionID: "second-goal", playerID: "goal-player", url: "https://www.youtube.com/watch?v=second-goal", mediaTitle: "Goal video", occurredAtMs: BASE + 75_001, positionSeconds: 45.001, state: "heartbeat" });
  const delivered = evaluateGoalCheckIn({ events: [...secondEvents, stillActive], event: stillActive, settings, state: pending.state, nowMs: BASE + 75_001 });
  equal(GOAL_CHECKIN_MIN_GAP_MS, 60_000);
  equal(delivered.shouldPrompt, true);

  const afterExistingNudge = evaluateGoalCheckIn({ events: secondEvents, event: secondEvents.at(-1), settings, nowMs: BASE + 45_000, lastInterventionAtMs: BASE + 20_000 });
  equal(afterExistingNudge.suppression, "cadence");
  equal(afterExistingNudge.state.processed.length, 0);
});

await test("goal canonical identity is retained for 24 hours then permits a fresh episode", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true };
  const firstEvents = goalProgressEvents({ id: "retention-first", url: "https://www.youtube.com/watch?v=retained", sessionID: "retention-first" });
  const first = evaluateGoalCheckIn({ events: firstEvents, event: firstEvents.at(-1), settings, nowMs: BASE + 15_000 });
  assert(first.shouldPrompt);
  const firstCompleted = completeGoalCheckInReservation(first.state, first.reservation, BASE + 15_001);

  const replay23 = goalProgressEvents({ id: "retention-23", url: "https://www.youtube.com/watch?v=retained", sessionID: "retention-23", startMs: BASE + 23 * 60 * 60_000 });
  const withinWindow = evaluateGoalCheckIn({ events: replay23, event: replay23.at(-1), settings, state: firstCompleted, nowMs: BASE + 23 * 60 * 60_000 + 15_000 });
  equal(withinWindow.suppression, "already_processed");

  const replay25 = goalProgressEvents({ id: "retention-25", url: "https://www.youtube.com/watch?v=retained", sessionID: "retention-25", startMs: BASE + 25 * 60 * 60_000 });
  const afterWindow = evaluateGoalCheckIn({ events: replay25, event: replay25.at(-1), settings, state: firstCompleted, nowMs: BASE + 25 * 60 * 60_000 + 15_000 });
  equal(afterWindow.shouldPrompt, true);
});

await test("current-stream nudge context is not taken from another concurrent player", () => {
  const current = goalProgressEvents({ id: "current-stream", seconds: 5, url: "https://video.example/current", sessionID: "current-stream", playerID: "current-stream", frameSite: "video.example", pageSite: "video.example" });
  const other = goalProgressEvents({ id: "other-stream", seconds: 40, url: "https://video.example/other", sessionID: "other-stream", playerID: "other-stream", startMs: BASE + 1_000, frameSite: "video.example", pageSite: "video.example" });
  near(activeSessionSeconds(current, BASE + 5_000), 5);
  assert(activeSessionSeconds([...current, ...other], BASE + 41_000) > 30);
});

await test("dashboard optimistic tail does not invent meaningful goal progress", () => {
  const singletonRotations = [0, 5, 10, 15].map((seconds, index) => event({
    eventID: `singleton-${index}`, sessionID: `singleton-${index}`, playerID: `singleton-${index}`,
    url: "https://www.youtube.com/watch?v=singleton", occurredAtMs: BASE + seconds * 1_000,
    positionSeconds: 0, state: "heartbeat"
  }));
  const dashboard = summarizeViewing(singletonRotations, { startMs: BASE, endMs: BASE + 60_000 }, { nowMs: BASE + 20_000 });
  assert(dashboard.activeSeconds > 15);
  near(meaningfulGoalPlaybackSeconds(singletonRotations, singletonRotations.at(-1)), 0);
});

await test("goal reservation survives restart, blocks concurrent heartbeats, and retries without false processing", () => {
  const settings = { trackingEnabled: true, notificationsEnabled: true };
  const events = goalProgressEvents({ id: "lease", url: "https://www.youtube.com/watch?v=lease", sessionID: "lease" });
  const reserved = evaluateGoalCheckIn({ events, event: events.at(-1), settings, nowMs: BASE + 15_000 });
  assert(reserved.shouldPrompt);
  const restartedPending = JSON.parse(JSON.stringify(reserved.state));
  const concurrent = evaluateGoalCheckIn({ events, event: events.at(-1), settings, state: restartedPending, nowMs: BASE + 20_000 });
  equal(concurrent.shouldPrompt, false);
  equal(concurrent.suppression, "pending");

  let failedState = failGoalCheckInReservation(reserved.state, reserved.reservation, BASE + 15_100);
  equal(failedState.processed.length, 0);
  const tooSoon = evaluateGoalCheckIn({ events, event: events.at(-1), settings, state: failedState, nowMs: BASE + 19_000 });
  equal(tooSoon.suppression, "pending");
  const retry = evaluateGoalCheckIn({ events, event: events.at(-1), settings, state: failedState, nowMs: BASE + 21_000 });
  assert(retry.shouldPrompt);
  failedState = failGoalCheckInReservation(retry.state, retry.reservation, BASE + 21_100);
  const retryTwo = evaluateGoalCheckIn({ events, event: events.at(-1), settings, state: failedState, nowMs: BASE + 32_000 });
  assert(retryTwo.shouldPrompt);
  failedState = failGoalCheckInReservation(retryTwo.state, retryTwo.reservation, BASE + 32_100);
  equal(failedState.processed.length, 0);
  assert(failedState.pending[0].retryAtMs >= BASE + 5 * 60_000);

  const unverifiedV1 = { schemaVersion: 1, processed: [{ identity: "youtube:lease", processedAtMs: BASE + 14_000 }] };
  const migrated = evaluateGoalCheckIn({ events, event: events.at(-1), settings, state: unverifiedV1, nowMs: BASE + 15_000 });
  assert(migrated.shouldPrompt, "unverified v0.3.8 processed state survived schema migration");
});

await test("plausible same-tab YouTube player rotation bridges meaningful progress", () => {
  const rotations = [0, 5, 10, 15, 20].map((seconds, index) => event({
    eventID: `rotation-${index}`, sessionID: `rotation-${index}`, playerID: `rotation-${index}`,
    url: index % 2 ? "https://www.youtube.com/embed/rotation" : "https://www.youtube.com/watch?v=rotation",
    occurredAtMs: BASE + seconds * 1_000, positionSeconds: seconds, state: "heartbeat"
  }));
  near(meaningfulGoalPlaybackSeconds(rotations, rotations.at(-1)), 20);
  const otherTab = event({ ...rotations.at(-1), eventID: "rotation-other-tab", sessionID: "rotation-other-tab", playerID: "rotation-other-tab", tabID: 9, occurredAtMs: BASE + 25_000, positionSeconds: 25 });
  near(meaningfulGoalPlaybackSeconds([...rotations, otherTab], otherTab), 0);
});

await test("realistic seek then 5-second heartbeat pipeline acknowledges one goal check-in", async () => {
  const shared = { sessionID: "pipeline", playerID: "pipeline-player", url: "https://www.youtube.com/watch?v=pipeline", mediaTitle: "Pipeline video" };
  const pipeline = [
    event({ ...shared, eventID: "pipeline-seeking", occurredAtMs: BASE, positionSeconds: 20, state: "seeking" }),
    event({ ...shared, eventID: "pipeline-seeked", occurredAtMs: BASE + 100, positionSeconds: 120, state: "seeking" }),
    event({ ...shared, eventID: "pipeline-play", occurredAtMs: BASE + 1_000, positionSeconds: 120, state: "playing" }),
    event({ ...shared, eventID: "pipeline-5", occurredAtMs: BASE + 6_000, positionSeconds: 125, state: "heartbeat" }),
    event({ ...shared, eventID: "pipeline-10", occurredAtMs: BASE + 11_000, positionSeconds: 130, state: "heartbeat" }),
    event({ ...shared, eventID: "pipeline-15", occurredAtMs: BASE + 16_000, positionSeconds: 135, state: "heartbeat" }),
    event({ ...shared, eventID: "pipeline-20", occurredAtMs: BASE + 21_000, positionSeconds: 140, state: "heartbeat" })
  ];
  let state = {};
  let prompts = 0;
  const calls = [];
  const browser = {
    tabs: { async sendMessage(_tabID, message) { calls.push(message); return { ok: true, shown: true }; } },
    notifications: { async create(_id, options) { calls.push(options); }, async clear() {} },
    runtime: { getURL(path) { return path; } }
  };
  for (let index = 0; index < pipeline.length; index += 1) {
    const current = pipeline[index];
    const decision = evaluateGoalCheckIn({ events: pipeline.slice(0, index + 1), event: current, settings: { trackingEnabled: true, notificationsEnabled: true }, state, nowMs: current.occurredAtMs });
    state = decision.state;
    if (!decision.shouldPrompt) continue;
    prompts += 1;
    const delivered = await deliverGoalCheckIn({ browser, event: current, isAllowed: async () => isGoalPlaybackActive(pipeline.slice(0, index + 1), current, current.occurredAtMs) });
    assert(delivered);
    state = completeGoalCheckInReservation(state, decision.reservation, current.occurredAtMs + 1);
  }
  equal(prompts, 1);
  equal(calls.filter((item) => item.type === "SHOW_TOAST").length, 1);
  equal(calls.filter((item) => item.message === GOAL_CHECKIN_MESSAGE).length, 1);
});

await test("analysis job survives JSON restart and resumes safely", () => {
  let submitting = createAnalysisJob({ jobID: "job-submit", url: "https://youtube.com/watch?v=a", mediaTitle: "Video", nowMs: BASE });
  submitting = transitionAnalysisJob(submitting, "submitting", { attempt: 1 }, BASE + 1);
  const restartedSubmitting = JSON.parse(JSON.stringify(submitting));
  equal(restartAction(restartedSubmitting, BASE + 1000), "submit");
  const retriedSubmitting = transitionAnalysisJob(restartedSubmitting, "submitting", { attempt: 2 }, BASE + 1000);
  equal(retriedSubmitting.status, "submitting");
  equal(retriedSubmitting.attempt, 2);

  let job = transitionAnalysisJob(retriedSubmitting, "running", { providerJobID: "remote-1", nextPollAtMs: BASE + 5000 }, BASE + 1001);
  const restarted = JSON.parse(JSON.stringify(job));
  validateAnalysisJob(restarted);
  equal(restartAction(restarted, BASE + 1000), "wait");
  equal(restartAction(restarted, BASE + 6000), "poll");
  const retriedRunning = transitionAnalysisJob(restarted, "running", { attempt: 3, nextPollAtMs: BASE + 12_000 }, BASE + 6000);
  equal(retriedRunning.status, "running");
  equal(retriedRunning.attempt, 3);
  throws(() => transitionAnalysisJob(restarted, "queued", {}, BASE + 7000));
  assert(!JSON.stringify(restarted).toLowerCase().includes("api_key"));
});

await test("analysis job status progression is monotonic and stale UI updates are rejected", () => {
  const queued = createAnalysisJob({ jobID: "status-progression", url: "https://youtube.com/watch?v=status", mediaTitle: "Video", nowMs: BASE });
  const submitting = transitionAnalysisJob(queued, "submitting", { attempt: 1 }, BASE);
  const remote = transitionAnalysisJob(submitting, "remote", { providerJobID: "remote-status", nextPollAtMs: BASE + 30_000 }, BASE);
  const running = transitionAnalysisJob(remote, "running", { attempt: 2, nextPollAtMs: null }, BASE);
  assert(submitting.updatedAtMs > queued.updatedAtMs);
  assert(remote.updatedAtMs > submitting.updatedAtMs);
  assert(running.updatedAtMs > remote.updatedAtMs);
  equal(shouldAcceptAnalysisJobUpdate(remote, queued), false);
  equal(shouldAcceptAnalysisJobUpdate(remote, submitting), false);
  equal(shouldAcceptAnalysisJobUpdate(remote, running), true);
});

await test("IndexedDB open calls share one in-flight request", async () => {
  let openCount = 0;
  let closeCount = 0;
  const database = { close() { closeCount += 1; }, onversionchange: null };
  const factory = {
    open() {
      openCount += 1;
      const request = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
      Promise.resolve().then(() => request.onsuccess());
      return request;
    }
  };
  const repository = new IndexedDBRepository({ indexedDBFactory: factory, dbName: "test" });
  await Promise.all([repository.open(), repository.open(), repository.open()]);
  equal(openCount, 1);
  database.onversionchange();
  equal(closeCount, 1);
  await repository.open();
  equal(openCount, 2);
});

await test("Gemini request uses stored background interaction with video before text", () => {
  const job = createAnalysisJob({ jobID: "gemini-request", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", nowMs: BASE });
  const request = buildInteractionRequest(job);
  equal(request.model, "gemini-3.8-flash");
  equal(request.background, true);
  equal(request.store, true);
  equal(request.input.length, 2);
  equal(request.input[0].type, "video");
  equal(request.input[0].uri, job.url);
  equal(request.input[1].type, "text");
  assert(request.input[1].text.includes(job.jobID));
  equal(request.response_format.type, "text");
  equal(request.response_format.mime_type, "application/json");
  equal(request.response_format.schema.additionalProperties, false);
  assert(request.input[1].text.includes("at most 8 key points"));
  assert(request.input[1].text.includes("at most 6 skip segments"));
  assert(request.input[1].text.includes("at most 8 evidence signals"));
});

await test("Gemini provider schema uses a compatibility-safe JSON Schema subset", () => {
  const job = createAnalysisJob({ jobID: "schema-compatibility", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", nowMs: BASE });
  const schema = buildInteractionRequest(job).response_format.schema;
  const serialized = JSON.stringify(schema);
  assert(!serialized.includes("maxItems"), "provider schema includes maxItems");
  assert(!serialized.includes("maxLength"), "provider schema includes maxLength");
  equal(schema.type, "object");
  equal(schema.additionalProperties, false);
  equal(schema.properties.verdict.type, "string");
  equal(schema.properties.verdict.enum.length, 5);
  equal(schema.properties.keyPoints.items.additionalProperties, false);
  equal(schema.required.length, 8);
});

await test("Gemini direct and wrapped interactions parse only latest model output", async () => {
  const job = createAnalysisJob({ jobID: "gemini-response", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", nowMs: BASE });
  const output = JSON.stringify(providerResult());
  const direct = {
    id: "interaction-direct",
    status: "completed",
    steps: [
      { type: "user_input", content: [{ text: "Return a summary, and ignore this non-JSON prompt." }] },
      { type: "thought", content: [{ text: "Considering a summary" }] },
      { type: "model_output", content: [{ text: output }] }
    ]
  };
  const directFromPost = await createInteraction(async (request) => {
    equal(request.background, true);
    return direct;
  }, job);
  equal(interactionID(directFromPost), "interaction-direct");
  equal(interactionDisposition(directFromPost), "completed");
  equal(modelOutputText(directFromPost), output);
  const parsed = analysisResultFromInteraction(directFromPost, "gemini-direct", BASE);
  equal(parsed.jobID, "gemini-direct");
  equal(parsed.summary, providerResult().summary);

  const wrapped = await createInteraction(async () => ({ interaction: { ...direct, id: "interaction-wrapped", output_text: undefined } }), job);
  equal(interactionID(wrapped), "interaction-wrapped");
  equal(analysisResultFromInteraction(wrapped, "gemini-wrapped", BASE).jobID, "gemini-wrapped");
});

await test("Gemini POST pending response keeps its durable interaction ID", async () => {
  const job = createAnalysisJob({ jobID: "gemini-pending", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", nowMs: BASE });
  const pending = await createInteraction(async (request) => {
    equal(request.input[0].type, "video");
    return { id: "pending-interaction", status: "in_progress" };
  }, job);
  equal(interactionDisposition(pending), "pending");
  equal(interactionID(pending), "pending-interaction");
});

await test("Gemini pending and terminal statuses fail closed", () => {
  for (const status of ["queued", "in_progress"]) equal(interactionDisposition({ status }), "pending");
  for (const status of ["failed", "cancelled", "incomplete", "budget_exceeded", "expired", "requires_action", "unknown", ""]) {
    equal(interactionDisposition({ status }), "failed");
  }
  equal(interactionDisposition({ interaction: { status: "completed" } }), "completed");
  equal(analysisResultFromInteraction({ status: "completed", steps: [{ type: "thought", content: [{ text: "no model JSON" }] }] }, "missing-output", BASE), null);
  throws(() => analysisResultFromInteraction({ status: "completed", steps: [{ type: "model_output", content: [{ text: "not JSON" }] }] }, "bad-output", BASE));
});

await test("Gemini HTTP and network failures receive non-sensitive categories", () => {
  equal(classifyHTTPFailure(401, { error: { message: "secret provider body" } }), "provider_auth");
  equal(classifyHTTPFailure(429, "quota exceeded"), "provider_quota");
  equal(classifyHTTPFailure(400, "This model does not support background interactions"), "provider_background_unsupported");
  equal(classifyHTTPFailure(400, "model gemini-x is not found"), "provider_model_unsupported");
  equal(classifyHTTPFailure(400, "YouTube video is private and unavailable"), "provider_video_unavailable");
  equal(classifyHTTPFailure(400, "invalid input"), "provider_invalid_request");
  equal(classifyHTTPFailure(400, { error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }), "provider_auth");
  equal(classifyHTTPFailure(400, { error: { code: "API_KEY_INVALID", message: "credential rejected" } }), "provider_auth");
  equal(classifyHTTPFailure(404, "model gemini-x not found"), "provider_model_unsupported");
  equal(classifyHTTPFailure(504, "gateway"), "provider_timeout");
  equal(classifyHTTPFailure(500, "internal"), "provider_service_error");
  equal(classifyHTTPFailure(502, "bad gateway"), "provider_service_error");
  equal(classifyHTTPFailure(503, "temporarily unavailable"), "provider_service_error");
  equal(classifyNetworkFailure({ name: "TimeoutError" }), "provider_timeout");
  equal(classifyNetworkFailure(new TypeError("Failed to fetch")), "provider_network");
  equal(classifyNetworkFailure(new Error("offline")), "provider_network");
});

await test("Gemini direct and wrapped failed interactions retain actionable categories", () => {
  const fixtures = [
    [{ status: "failed", error: { code: "UNAUTHENTICATED", message: "API key rejected" } }, "provider_auth"],
    [{ interaction: { status: "failed", errors: [{ code: "RESOURCE_EXHAUSTED", message: "Quota and billing limit" }] } }, "provider_quota"],
    [{ status: "failed", error: { code: "INVALID_ARGUMENT", message: "Background interactions are not supported" } }, "provider_background_unsupported"],
    [{ interaction: { status: "failed", error: { code: "NOT_FOUND", message: "Requested model is not found" } } }, "provider_model_unsupported"],
    [{ status: "failed", error: { code: "PERMISSION_DENIED", message: "YouTube video is private or restricted" } }, "provider_video_unavailable"],
    [{ interaction: { status: "failed", error: { code: "DEADLINE_EXCEEDED", message: "Timed out" } } }, "provider_timeout"],
    [{ status: "failed", error: { code: "UNAVAILABLE", message: "Service unavailable" } }, "provider_service_error"],
    [{ interaction: { status: "failed", error: { code: "INTERNAL", message: "Internal service error" } } }, "provider_service_error"],
    [{ interaction: { status: "failed", error: { code: "INVALID_ARGUMENT", message: "Invalid request" } } }, "provider_invalid_request"],
    [{ status: "failed", error: { code: "UNKNOWN", message: "Opaque terminal failure" } }, "provider_failed"]
  ];
  for (const [fixture, expected] of fixtures) equal(classifyInteractionFailure(fixture), expected);
});

await test("Gemini background incompatibility falls back synchronously exactly once", async () => {
  const attempts = [];
  const value = await createWithBackgroundFallback(async (background) => {
    attempts.push(background);
    if (background) throw new ProviderProtocolError("provider_background_unsupported");
    return { status: "completed" };
  });
  equal(value.status, "completed");
  equal(JSON.stringify(attempts), JSON.stringify([true, false]));

  const job = createAnalysisJob({ jobID: "terminal-fallback", url: "https://www.youtube.com/watch?v=abc", mediaTitle: "Video", nowMs: BASE });
  const requestModes = [];
  const completed = await createInteraction(async (request) => {
    requestModes.push(request.background);
    if (request.background) return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "Background interactions are not supported" } };
    return { status: "completed", steps: [{ type: "model_output", content: [{ text: JSON.stringify(providerResult()) }] }] };
  }, job);
  equal(interactionDisposition(completed), "completed");
  equal(JSON.stringify(requestModes), JSON.stringify([true, false]));

  const invalidModes = [];
  const invalid = await createInteraction(async (request) => {
    invalidModes.push(request.background);
    return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "Invalid request" } };
  }, job);
  equal(classifyInteractionFailure(invalid), "provider_invalid_request");
  equal(JSON.stringify(invalidModes), JSON.stringify([true]));

  for (const code of ["provider_invalid_request", "provider_quota", "provider_auth"]) {
    const genericAttempts = [];
    await rejects(() => createWithBackgroundFallback(async (background) => {
      genericAttempts.push(background);
      throw new ProviderProtocolError(code);
    }), code);
    equal(JSON.stringify(genericAttempts), JSON.stringify([true]));
  }
});

await test("malformed AI results are rejected", () => {
  validateAnalysisResult(successfulResult());
  throws(() => validateAnalysisResult(successfulResult({ summary: "x".repeat(1201) })));
  throws(() => validateAnalysisResult(successfulResult({ keyPoints: Array.from({ length: 9 }, (_, index) => ({ seconds: index, text: "point" })) })));
  throws(() => validateAnalysisResult(successfulResult({ keyPoints: [{ seconds: 1, text: "x".repeat(501) }] })));
  throws(() => validateAnalysisResult(successfulResult({ skipSegments: Array.from({ length: 7 }, (_, index) => ({ startSeconds: index * 2, endSeconds: index * 2 + 1, reason: "skip" })) })));
  throws(() => validateAnalysisResult(successfulResult({ evidence: Array.from({ length: 9 }, () => "evidence") })));
  throws(() => validateAnalysisResult(successfulResult({ evidence: ["x".repeat(501)] })));
  throws(() => validateAnalysisResult(successfulResult({ caveat: `This is not an external fact-check. ${"x".repeat(500)}` })));
  throws(() => validateAnalysisResult(successfulResult({ caveat: "Looks accurate." })));
  throws(() => validateAnalysisResult(successfulResult({ caveat: "This is an external fact-check." })));
  throws(() => validateAnalysisResult(successfulResult({ confidence: 5 })));
  throws(() => validateAnalysisResult(successfulResult({ skipSegments: [{ startSeconds: 10, endSeconds: 5, reason: "bad" }] })));
  const unknown = successfulResult(); unknown.rawModelResponse = "private";
  throws(() => validateAnalysisResult(unknown));
});

await test("in-memory repository validates, exports safely, prunes, and deletes", async () => {
  const repository = new InMemoryRepository();
  await repository.putEvent(event());
  await repository.putEvent(event({ eventID: "legacy-home-preview", sessionID: "legacy-home", playerID: "legacy-home-player", url: "https://www.youtube.com/" }));
  const job = createAnalysisJob({ jobID: "job-1", url: "https://youtube.com/watch?v=a", mediaTitle: "Video", nowMs: BASE });
  await repository.putAnalysisJob(job);
  const exported = await repository.exportData({ trackingEnabled: true, geminiApiKey: "secret" });
  equal(exported.playbackEvents.length, 1);
  assert(!JSON.stringify(exported).includes("legacy-home-preview"));
  assert(!JSON.stringify(exported).includes("secret"));
  await repository.prune(BASE + 1);
  equal((await repository.listEvents()).length, 0);
  equal((await repository.listAnalysisJobs()).length, 1); // non-terminal jobs survive pruning
  await repository.deleteAll();
  equal((await repository.listAnalysisJobs()).length, 0);
});

await test("rabbit-hole helper isolates distinct sessions", () => {
  const events = [event({ eventID: "d1", sessionID: "s1" }), event({ eventID: "d2", sessionID: "s1", occurredAtMs: BASE + 1 }), event({ eventID: "d3", sessionID: "s2", occurredAtMs: BASE + 2 })];
  equal(distinctSessionsInWindow(events, BASE + 3), 2);
});

print(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) throw new Error(failures.join("\n"));
