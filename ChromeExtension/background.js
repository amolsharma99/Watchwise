import {
  IndexedDBRepository,
  NudgeEngine,
  activeSessionSeconds,
  analysisResultFromInteraction,
  aiEvidenceFromResult,
  automaticAnalysisEligibility,
  automaticSubmissionEligibility,
  canonicalizePublicURL,
  classifyHTTPFailure,
  classifyInteractionFailure,
  classifyNetworkFailure,
  completeGoalCheckInReservation,
  createInteraction,
  createAnalysisJob,
  dayWindow,
  distinctSessionsInWindow,
  deliverGoalCheckIn,
  evaluateGoalCheckIn,
  failGoalCheckInReservation,
  GOAL_CHECKIN_MIN_GAP_MS,
  isExcludedSite,
  isQuietTime,
  interactionDisposition,
  interactionID,
  isGoalPlaybackActive,
  isUnidentifiedYouTubeURL,
  normalizeHostname,
  normalizeSettings,
  playbackStreamKey,
  ProviderProtocolError,
  restartAction,
  retainAnalysisSourcesForJobs,
  summarizeViewing,
  transitionAnalysisJob,
  validatePlaybackEvent,
  weekWindow,
  youtubeVideoIdentity
} from "./lib/index.js";

const SETTINGS_KEY = "watchwiseSettings";
const API_KEY = "geminiApiKey";
const ONBOARDING_KEY = "onboardingComplete";
const NUDGE_STATE_KEY = "nudgeState";
const GOAL_CHECK_STATE_KEY = "goalCheckInState";
const ANALYSIS_SOURCES_KEY = "analysisSources";
const ANALYSIS_ALARM = "watchwise-analysis-poll";
const INSIGHTS_ALARM = "watchwise-insights-refresh";
const PRUNE_ALARM = "watchwise-prune";
const SESSION_GAP_MS = 10 * 60_000;
const RETENTION_MS = 180 * 24 * 60 * 60_000;
const DASHBOARD_UPDATE_INTERVAL_MS = 1_000;
const CONTENT_LIFECYCLE = "watchwise-tracker-v0.3.9";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const repository = new IndexedDBRepository();
const sessions = new Map();
let storageReadyPromise;
let historyGeneration = 0;
let dataMutationQueue = Promise.resolve();
let settingsRevision = 0;
let dashboardUpdateTimer = null;
let lastDashboardUpdateAtMs = 0;
let contentRecoveryPromise = null;
const activeAnalysisJobs = new Set();

function withDataMutation(operation) {
  const run = dataMutationQueue.then(operation, operation);
  dataMutationQueue = run.catch(() => {});
  return run;
}

function protectLocalStorage() {
  if (!storageReadyPromise) {
    storageReadyPromise = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
  return storageReadyPromise;
}

async function localGet(keys) { await protectLocalStorage(); return chrome.storage.local.get(keys); }
async function localSet(values) { await protectLocalStorage(); return chrome.storage.local.set(values); }
async function localRemove(keys) { await protectLocalStorage(); return chrome.storage.local.remove(keys); }

function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function publicError(error) {
  if (error?.name === "ValidationError") return "That value is not valid or allowed.";
  if (error?.code === "AI_DISABLED") return "Enable optional Gemini analysis first.";
  if (error?.code === "KEY_MISSING") return "Save a Gemini API key before analysing.";
  if (error?.code === "MOVIE_MODE") return "Analysis is paused while Movie Mode is active.";
  if (error?.code === "SITE_EXCLUDED") return "That site is excluded from Watchwise.";
  if (error?.code === "unsupported_analysis_site") return "Gemini URL analysis currently supports public YouTube videos.";
  return "Watchwise could not complete that action.";
}

function analysisErrorMessage(code) {
  const messages = {
    provider_auth: "Gemini rejected the saved API key. Check or replace it in Settings.",
    provider_quota: "Gemini quota or billing is unavailable. Check your Google AI account before retrying.",
    provider_invalid_request: "Gemini rejected this analysis request. Try another public YouTube video or update Watchwise.",
    provider_model_unsupported: "The configured Gemini model is unavailable for this API key or region.",
    provider_background_unsupported: "Gemini could not run this video analysis in either supported request mode.",
    provider_video_unavailable: "Gemini could not access this video. It may be private, restricted, unlisted, or unavailable.",
    provider_network: "The Gemini request could not reach the service. Check your connection and try again.",
    provider_service_error: "Gemini returned a temporary service error. Wait a little, then try this video once more.",
    provider_timeout: "The Gemini request timed out. Try again when the connection is stable.",
    provider_response: "Gemini returned an unexpected response. No result was saved.",
    provider_failed: "Gemini reported that the analysis did not complete.",
    provider_unavailable: "Gemini analysis is temporarily unavailable. Try again later."
  };
  return messages[code] ?? "Analysis failed without exposing provider details.";
}

function controlledError(code) { const error = new Error(code); error.code = code; return error; }

async function getSettings() {
  const stored = await localGet(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("invalid settings patch");
  const allowed = new Set([
    "trackingEnabled", "notificationsEnabled", "aiEnabled", "excludedSites",
    "autoAnalysisEnabled",
    "movieModeUntilMs", "snoozedUntilMs", "quietHoursEnabled",
    "quietHoursStartMinute", "quietHoursEndMinute", "dailyLimitSeconds", "longSessionSeconds"
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new TypeError("unknown settings field");
  if (Object.hasOwn(patch, "excludedSites")) {
    if (!Array.isArray(patch.excludedSites)) throw new TypeError("invalid exclusions");
    patch = { ...patch, excludedSites: patch.excludedSites.map((site) => normalizeHostname(site)) };
  }
  let settings;
  await withDataMutation(async () => {
    settings = normalizeSettings({ ...(await getSettings()), ...patch });
    settingsRevision += 1;
    await localSet({ [SETTINGS_KEY]: settings });
  });
  await broadcastTrackingState();
  if (settings.trackingEnabled) void recoverExistingContentScripts(settings);
  if (!interventionsAllowed(settings, Date.now())) await clearInterventions();
  return settings;
}

async function setInitialState() {
  await protectLocalStorage();
  const stored = await chrome.storage.local.get([SETTINGS_KEY, ONBOARDING_KEY]);
  if (!stored[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings() });
  if (typeof stored[ONBOARDING_KEY] !== "boolean") await chrome.storage.local.set({ [ONBOARDING_KEY]: false });
  await repository.open();
  await pruneRetainedData(Date.now() - RETENTION_MS);
  await ensureAlarms();
}

async function pruneRetainedData(beforeMs) {
  return withDataMutation(async () => {
    await repository.prune(beforeMs);
    const jobs = await repository.listAnalysisJobs();
    const stored = await localGet(ANALYSIS_SOURCES_KEY);
    const retainedSources = retainAnalysisSourcesForJobs(stored[ANALYSIS_SOURCES_KEY], jobs);
    await localSet({ [ANALYSIS_SOURCES_KEY]: retainedSources });
  });
}

async function ensureAlarms() {
  await chrome.alarms.create(ANALYSIS_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.create(INSIGHTS_ALARM, { periodInMinutes: 5 });
  await chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 24 * 60 });
}

function eligibleHTTPSContentTab(tab) {
  return Number.isInteger(tab?.id) && typeof tab.url === "string" && tab.url.startsWith("https://");
}

async function probeContentScript(tabID) {
  try {
    const response = await chrome.tabs.sendMessage(tabID, { type: "CONTENT_HEALTH_PROBE" }, { frameId: 0 });
    return {
      live: response?.ok === true && response.lifecycle === CONTENT_LIFECYCLE,
      trackingEnabled: response?.trackingEnabled === true
    };
  } catch { return { live: false, trackingEnabled: false }; }
}

async function refreshContentScriptState(tabID) {
  try {
    const response = await chrome.tabs.sendMessage(tabID, { type: "REFRESH_TRACKING_STATE" });
    return response?.ok === true;
  } catch { return false; }
}

async function injectContentScript(tab) {
  if (!eligibleHTTPSContentTab(tab)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"]
    });
    return true;
  } catch {
    // An inaccessible child frame must not prevent recovery of the main video
    // document.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ["content.js"]
      });
      return true;
    } catch { return false; }
  }
}

async function recoverContentScriptInTab(tab, settings) {
  if (!settings.trackingEnabled || !eligibleHTTPSContentTab(tab)) return false;
  let site;
  try { site = normalizeHostname(new URL(tab.url).hostname); }
  catch { return false; }
  if (isExcludedSite(site, settings)) return false;
  const health = await probeContentScript(tab.id);
  if (health.live && health.trackingEnabled) return true;
  if (health.live) {
    await refreshContentScriptState(tab.id);
    const refreshed = await probeContentScript(tab.id);
    return refreshed.live && refreshed.trackingEnabled;
  }
  return injectContentScript(tab);
}

async function recoverExistingContentScripts(providedSettings = null) {
  if (contentRecoveryPromise) return contentRecoveryPromise;
  const recovery = (async () => {
    const settings = providedSettings ?? await getSettings();
    if (!settings.trackingEnabled) return;
    const tabs = await chrome.tabs.query({ url: "https://*/*" });
    await Promise.allSettled(tabs.filter(eligibleHTTPSContentTab).map((tab) => recoverContentScriptInTab(tab, settings)));
  })();
  contentRecoveryPromise = recovery;
  try { return await recovery; }
  finally { if (contentRecoveryPromise === recovery) contentRecoveryPromise = null; }
}

async function activeTabTrackingConnection(tab, settings) {
  if (!settings.trackingEnabled) return { status: "not_applicable", reason: "tracking_off" };
  if (!eligibleHTTPSContentTab(tab)) return { status: "not_applicable", reason: "unsupported" };
  let site;
  try { site = normalizeHostname(new URL(tab.url).hostname); }
  catch { return { status: "not_applicable", reason: "unsupported" }; }
  if (isExcludedSite(site, settings)) return { status: "not_applicable", reason: "excluded" };
  const health = await probeContentScript(tab.id);
  if (health.live && health.trackingEnabled) return { status: "connected", reason: null };
  if (health.live) {
    await refreshContentScriptState(tab.id);
    const refreshed = await probeContentScript(tab.id);
    return refreshed.live && refreshed.trackingEnabled
      ? { status: "connected", reason: null }
      : { status: "reconnecting", reason: "health_pending" };
  }
  if (!(await recoverContentScriptInTab(tab, settings))) return { status: "reload_required", reason: "injection_failed" };
  const recovered = await probeContentScript(tab.id);
  return recovered.live && recovered.trackingEnabled
    ? { status: "connected", reason: null }
    : { status: "reconnecting", reason: "health_pending" };
}

function frameContext(sender) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id) || !Number.isInteger(sender.frameId)) throw new TypeError("missing frame context");
  const frameURL = new URL(sender.url);
  const pageURL = new URL(sender.tab.url);
  if (frameURL.protocol !== "https:" || pageURL.protocol !== "https:") throw new TypeError("HTTPS frame required");
  return {
    tabID: sender.tab.id,
    frameID: sender.frameId,
    frameSite: normalizeHostname(frameURL.hostname),
    pageSite: normalizeHostname(pageURL.hostname),
    tabActive: sender.tab.active === true,
    windowID: sender.tab.windowId
  };
}

async function trackingStateForSender(sender, settings = null) {
  settings ||= await getSettings();
  try {
    const context = frameContext(sender);
    return { enabled: settings.trackingEnabled && !isExcludedSite(context.frameSite, settings) && !isExcludedSite(context.pageSite, settings) };
  } catch { return { enabled: false }; }
}

async function broadcastTrackingState() {
  const tabs = await chrome.tabs.query({ url: "https://*/*" });
  // Every frame re-registers so frame and top-page exclusions are evaluated together.
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "REFRESH_TRACKING_STATE" })));
}

async function clearInterventions() {
  const tabs = await chrome.tabs.query({ url: "https://*/*" });
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "HIDE_TOAST" })));
}

function deliverDashboardUpdate() {
  lastDashboardUpdateAtMs = Date.now();
  return chrome.runtime.sendMessage({ type: "DASHBOARD_UPDATED" }).catch(() => {});
}

function announceDashboardUpdated({ immediate = false } = {}) {
  if (immediate) {
    if (dashboardUpdateTimer) clearTimeout(dashboardUpdateTimer);
    dashboardUpdateTimer = null;
    return deliverDashboardUpdate();
  }
  if (dashboardUpdateTimer) return Promise.resolve();
  const delayMs = Math.max(0, DASHBOARD_UPDATE_INTERVAL_MS - (Date.now() - lastDashboardUpdateAtMs));
  if (delayMs === 0) return deliverDashboardUpdate();
  dashboardUpdateTimer = setTimeout(() => {
    dashboardUpdateTimer = null;
    void deliverDashboardUpdate();
  }, delayMs);
  return Promise.resolve();
}

async function isWindowFocused(windowID) {
  try { return (await chrome.windows.get(windowID)).focused === true; }
  catch { return false; }
}

async function resolveSessionID(context, raw, occurredAtMs) {
  const key = `${context.tabID}:${context.frameID}:${raw.playerId}`;
  const current = sessions.get(key);
  if (current && !current.ended && current.url === raw.url && occurredAtMs - current.lastSeenMs <= SESSION_GAP_MS) {
    current.lastSeenMs = Math.max(current.lastSeenMs, occurredAtMs);
    current.ended = raw.state === "ended";
    return current.sessionID;
  }
  const recent = await repository.listEvents(occurredAtMs - SESSION_GAP_MS, occurredAtMs + 1);
  const prior = recent.filter((event) => event.tabID === context.tabID && event.frameID === context.frameID && event.playerID === raw.playerId && event.url === raw.url).at(-1);
  const sessionID = prior && prior.state !== "ended" ? prior.sessionID : crypto.randomUUID();
  sessions.set(key, { sessionID, url: raw.url, lastSeenMs: occurredAtMs, ended: raw.state === "ended" });
  return sessionID;
}

function validateRawPlayback(raw) {
  const allowed = new Set(["schemaVersion", "playerId", "title", "url", "site", "duration", "position", "playbackRate", "state", "occurredAtMilliseconds", "documentVisible"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.has(key))) throw new TypeError("invalid raw event");
  if (raw.schemaVersion !== 1 || typeof raw.playerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.playerId)) throw new TypeError("invalid player");
  const nowMs = Date.now();
  if (typeof raw.documentVisible !== "boolean" || (!raw.documentVisible && raw.state !== "paused") || typeof raw.occurredAtMilliseconds !== "number" || raw.occurredAtMilliseconds > nowMs + 5 * 60_000 || raw.occurredAtMilliseconds < nowMs - 10 * 60_000) throw new TypeError("invalid event time");
  return raw;
}

async function ingestPlayback(rawInput, sender) {
  const raw = validateRawPlayback(rawInput);
  const context = frameContext(sender);
  const generation = historyGeneration;
  if (normalizeHostname(raw.site) !== context.frameSite) throw new TypeError("frame site mismatch");
  if (isUnidentifiedYouTubeURL(raw.url)) return { accepted: false };
  const settings = await getSettings();
  if (!settings.trackingEnabled || isExcludedSite(context.frameSite, settings) || isExcludedSite(context.pageSite, settings)) return { accepted: false };
  const revision = settingsRevision;
  const occurredAtMs = raw.occurredAtMilliseconds;
  const isTabActive = context.tabActive && await isWindowFocused(context.windowID);
  const event = await withDataMutation(async () => {
    if (generation !== historyGeneration || revision !== settingsRevision) return null;
    const sessionID = await resolveSessionID(context, raw, occurredAtMs);
    if (generation !== historyGeneration || revision !== settingsRevision) {
      sessions.clear();
      return null;
    }
    const validated = validatePlaybackEvent({
      schemaVersion: 1,
      eventID: crypto.randomUUID(),
      sessionID,
      playerID: raw.playerId,
      tabID: context.tabID,
      frameID: context.frameID,
      frameSite: context.frameSite,
      pageSite: context.pageSite,
      url: raw.url,
      mediaTitle: raw.title,
      durationSeconds: raw.duration,
      positionSeconds: raw.position,
      playbackRate: raw.playbackRate,
      state: raw.state,
      occurredAtMs,
      isVisible: raw.documentVisible,
      isTabActive
    });
    await repository.putEvent(validated);
    return validated;
  });
  if (!event) return { accepted: false };
  void announceDashboardUpdated();
  if (["playing", "heartbeat"].includes(event.state) && event.isVisible && event.isTabActive) {
    try { await maybeStartAutomaticAnalysis(event, generation); } catch {}
  }
  if (["playing", "heartbeat"].includes(event.state)) {
    const deliveredGoalCheckIn = await maybeGoalCheckIn(event, generation);
    if (!deliveredGoalCheckIn) await maybeNudge(event, generation);
  }
  return { accepted: true };
}

async function findAnalysisEvidence(event) {
  const videoKey = youtubeVideoIdentity(event.url)?.videoKey;
  if (!videoKey) return null;
  const jobs = (await repository.listAnalysisJobs()).filter((job) => job.status === "succeeded" && youtubeVideoIdentity(job.url)?.videoKey === videoKey).reverse();
  if (!jobs.length) return null;
  const result = await repository.getAnalysisResult(jobs[0].jobID);
  return result ? aiEvidenceFromResult(result, event.positionSeconds) : null;
}

function interventionsAllowed(settings, nowMs, pageSite = null, frameSite = null) {
  return settings.trackingEnabled === true
    && settings.notificationsEnabled === true
    && !(settings.movieModeUntilMs > nowMs)
    && !(settings.snoozedUntilMs > nowMs)
    && !isQuietTime(nowMs, settings)
    && (!pageSite || !isExcludedSite(pageSite, settings))
    && (!frameSite || !isExcludedSite(frameSite, settings));
}

async function maybeGoalCheckIn(event, generation = historyGeneration) {
  let reservation = null;
  await withDataMutation(async () => {
    if (generation !== historyGeneration) return;
    const settings = await getSettings();
    const revision = settingsRevision;
    const [events, stored] = await Promise.all([
      repository.listEvents(event.occurredAtMs - 20 * 60_000, event.occurredAtMs + 1),
      localGet([GOAL_CHECK_STATE_KEY, NUDGE_STATE_KEY])
    ]);
    if (generation !== historyGeneration || revision !== settingsRevision) return;
    const decision = evaluateGoalCheckIn({
      events,
      event,
      settings,
      state: stored[GOAL_CHECK_STATE_KEY] || {},
      nowMs: Date.now(),
      lastInterventionAtMs: stored[NUDGE_STATE_KEY]?.emittedAtMs?.at?.(-1) ?? null
    });
    await localSet({ [GOAL_CHECK_STATE_KEY]: decision.state });
    if (decision.shouldPrompt && generation === historyGeneration && revision === settingsRevision) {
      reservation = { generation, revision, ...decision.reservation };
    }
  });
  if (!reservation) return false;

  const stillAllowed = async () => {
    const currentSettings = await getSettings();
    const nowMs = Date.now();
    const recentEvents = await repository.listEvents(event.occurredAtMs, nowMs + 1);
    return reservation.generation === historyGeneration
      && reservation.revision === settingsRevision
      && currentSettings.trackingEnabled
      && interventionsAllowed(currentSettings, nowMs, event.pageSite, event.frameSite)
      && isGoalPlaybackActive(recentEvents, event, nowMs);
  };
  const delivered = await deliverGoalCheckIn({ browser: chrome, event, isAllowed: stillAllowed });
  await withDataMutation(async () => {
    if (generation !== historyGeneration) return;
    const stored = await localGet(GOAL_CHECK_STATE_KEY);
    const next = delivered
      ? completeGoalCheckInReservation(stored[GOAL_CHECK_STATE_KEY] || {}, reservation, Date.now())
      : failGoalCheckInReservation(stored[GOAL_CHECK_STATE_KEY] || {}, reservation, Date.now());
    await localSet({ [GOAL_CHECK_STATE_KEY]: next });
  });
  return delivered;
}

async function maybeNudge(event, generation = historyGeneration) {
  if (generation !== historyGeneration) return;
  const nowMs = Date.now();
  const todayRange = dayWindow(nowMs);
  const events = await repository.listEvents(Math.min(todayRange.startMs, nowMs - 20 * 60_000), nowMs + 1);
  const today = summarizeViewing(events, todayRange, { nowMs });
  const streamKey = playbackStreamKey(event);
  const streamEvents = events.filter((item) => playbackStreamKey(item) === streamKey);
  const aiEvidence = await findAnalysisEvidence(event);
  let decision = null;
  let revision = settingsRevision;
  await withDataMutation(async () => {
    if (generation !== historyGeneration) return;
    const currentSettings = await getSettings();
    const currentRevision = settingsRevision;
    if (!interventionsAllowed(currentSettings, Date.now(), event.pageSite, event.frameSite)) return;
    const stored = await localGet([NUDGE_STATE_KEY, GOAL_CHECK_STATE_KEY]);
    if (generation !== historyGeneration || currentRevision !== settingsRevision) return;
    const goalLast = stored[GOAL_CHECK_STATE_KEY]?.lastInterventionAtMs;
    if (Number.isFinite(goalLast) && nowMs - goalLast < GOAL_CHECKIN_MIN_GAP_MS) return;
    const engine = new NudgeEngine(stored[NUDGE_STATE_KEY] || {});
    const evaluated = engine.evaluate({
      nowMs,
      pageSite: event.pageSite,
      dailyActiveSeconds: today.activeSeconds,
      activeSessionSeconds: activeSessionSeconds(streamEvents, nowMs) || 0,
      distinctSessionsLast20Minutes: distinctSessionsInWindow(events, nowMs),
      playbackRate: event.playbackRate,
      positionSeconds: event.positionSeconds,
      aiEvidence
    }, currentSettings);
    await localSet({ [NUDGE_STATE_KEY]: engine.exportState() });
    if (evaluated.nudge) {
      decision = evaluated;
      revision = currentRevision;
    }
  });
  if (!decision?.nudge) return;
  const currentSettings = await getSettings();
  if (generation !== historyGeneration || revision !== settingsRevision || !interventionsAllowed(currentSettings, Date.now(), event.pageSite, event.frameSite)) return;
  const nudge = decision.nudge;
  let toastDelivered = false;
  try {
    await chrome.tabs.sendMessage(event.tabID, {
      type: "SHOW_TOAST",
      text: `${nudge.title} ${nudge.message}`,
      actionLabel: Number.isFinite(nudge.suggestedTimestampSeconds) ? "Skip there" : "Open Watchwise",
      action: Number.isFinite(nudge.suggestedTimestampSeconds)
        ? { type: "seek", playerId: event.playerID, seconds: nudge.suggestedTimestampSeconds }
        : { type: "open_panel" }
    }, { frameId: event.frameID });
    toastDelivered = true;
  } catch {}
  if (generation !== historyGeneration || revision !== settingsRevision || !interventionsAllowed(await getSettings(), Date.now(), event.pageSite, event.frameSite)) {
    if (toastDelivered) await chrome.tabs.sendMessage(event.tabID, { type: "HIDE_TOAST" }, { frameId: event.frameID }).catch(() => {});
  }
}

async function getDashboardState() {
  const nowMs = Date.now();
  const settings = await getSettings();
  const todayRange = dayWindow(nowMs);
  const weekRange = weekWindow(nowMs);
  const previousWeek = { startMs: weekRange.startMs - (weekRange.endMs - weekRange.startMs), endMs: weekRange.startMs };
  const events = await repository.listEvents(previousWeek.startMs, nowMs + 1);
  const jobs = await repository.listAnalysisJobs();
  const activeJobBase = jobs.at(-1) || null;
  const activeJob = await enrichAnalysisJob(activeJobBase);
  const stored = await localGet([ONBOARDING_KEY, API_KEY]);
  let currentPublicURL = null;
  let activeTab = null;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.url) currentPublicURL = canonicalizePublicURL(activeTab.url);
  } catch {}
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    onboardingComplete: stored[ONBOARDING_KEY] === true,
    settings,
    today: summarizeViewing(events, todayRange, { nowMs }),
    week: summarizeViewing(events, weekRange, { nowMs }),
    previousWeekActiveSeconds: summarizeViewing(events, previousWeek).activeSeconds,
    trackingConnection: await activeTabTrackingConnection(activeTab, settings),
    apiKeyConfigured: typeof stored[API_KEY] === "string" && stored[API_KEY].length > 0,
    activeJob,
    currentPublicURL
  };
}

async function enrichAnalysisJob(job, generation = historyGeneration) {
  if (!job) return null;
  const current = await repository.getAnalysisJob(job.jobID);
  if (!current || generation !== historyGeneration) return null;
  const result = current.status === "succeeded" ? await repository.getAnalysisResult(current.jobID) : null;
  const stored = await localGet(ANALYSIS_SOURCES_KEY);
  if (generation !== historyGeneration || !(await repository.getAnalysisJob(current.jobID))) return null;
  return {
    ...current,
    result,
    source: stored[ANALYSIS_SOURCES_KEY]?.[current.jobID] ?? null,
    error: current.status === "failed" ? analysisErrorMessage(current.errorCode) : null
  };
}

async function broadcastAnalysisJob(job, generation = historyGeneration) {
  const current = await enrichAnalysisJob(job, generation);
  if (!current) return;
  await chrome.runtime.sendMessage({ type: "ANALYSIS_JOB_UPDATED", job: current }).catch(() => {});
}

async function fetchGemini(url, options, key) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key, ...(options.headers || {}) },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw new ProviderProtocolError(classifyNetworkFailure(error));
  }
  let text;
  try { text = await response.text(); }
  catch (error) { throw new ProviderProtocolError(classifyNetworkFailure(error)); }
  if (text.length > 2_000_000) throw controlledError("provider_response");
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      if (response.ok) throw new ProviderProtocolError("provider_response");
      data = text.slice(0, 64_000);
    }
  }
  if (!response.ok) throw new ProviderProtocolError(classifyHTTPFailure(response.status, data));
  if (!data || typeof data !== "object") throw new ProviderProtocolError("provider_response");
  return data;
}

async function analysisKey() {
  const stored = await localGet(API_KEY);
  if (typeof stored[API_KEY] !== "string" || !stored[API_KEY]) throw controlledError("KEY_MISSING");
  return stored[API_KEY];
}

async function putJobIfCurrent(job, generation) {
  const persisted = await withDataMutation(async () => {
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return false;
    await repository.putAnalysisJob(job);
    return true;
  });
  if (persisted) await broadcastAnalysisJob(job, generation);
  return persisted;
}

async function completeJob(job, result, generation) {
  let completed = null;
  await withDataMutation(async () => {
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return;
    const running = job.status === "submitting" ? transitionAnalysisJob(job, "running", {}, Date.now()) : job;
    completed = transitionAnalysisJob(running, "succeeded", { nextPollAtMs: null }, Date.now());
    await repository.putAnalysisResult(result);
    await repository.putAnalysisJob(completed);
  });
  if (!completed || generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return null;
  await announceAnalysisReady(completed, result, generation);
  return completed;
}

async function failJob(job, errorCode = "provider_unavailable", generation = historyGeneration) {
  try {
    return await withDataMutation(async () => {
      if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return null;
      const failed = transitionAnalysisJob(job, "failed", { errorCode, nextPollAtMs: null }, Date.now());
      await repository.putAnalysisJob(failed);
      await chrome.runtime.sendMessage({ type: "ANALYSIS_JOB_UPDATED", job: { ...failed, error: analysisErrorMessage(errorCode) } }).catch(() => {});
      return failed;
    });
  } catch { return null; }
}

async function submitAnalysis(job, generation = historyGeneration) {
  const settings = await getSettings();
  if (activeAnalysisJobs.has(job.jobID) || !settings.aiEnabled) return null;
  if ((job.origin ?? "manual") === "automatic" && !(await automaticJobSubmissionAllowed(job, settings))) return null;
  activeAnalysisJobs.add(job.jobID);
  let submitting;
  try {
    submitting = transitionAnalysisJob(job, "submitting", { attempt: job.attempt + 1 }, Date.now());
    if (!(await putJobIfCurrent(submitting, generation))) return null;
    const currentSettings = await getSettings();
    if (!currentSettings.aiEnabled) return null;
    if ((job.origin ?? "manual") === "automatic" && !(await automaticJobSubmissionAllowed(job, currentSettings))) return null;
    const key = await analysisKey();
    const data = await createInteraction((request) => fetchGemini(GEMINI_ENDPOINT, {
      method: "POST",
      body: JSON.stringify(request)
    }, key), submitting);
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return null;
    const disposition = interactionDisposition(data);
    if (disposition === "failed") return failJob(submitting, classifyInteractionFailure(data), generation);
    if (disposition === "completed") {
      try {
        const result = analysisResultFromInteraction(data, submitting.jobID, Date.now());
        return result ? completeJob(submitting, result, generation) : failJob(submitting, "provider_response", generation);
      } catch {
        return failJob(submitting, "provider_response", generation);
      }
    }
    const providerJobID = interactionID(data);
    if (!providerJobID) throw controlledError("provider_response");
    const remote = transitionAnalysisJob(submitting, "remote", { providerJobID, nextPollAtMs: Date.now() + 30_000 }, Date.now());
    return await putJobIfCurrent(remote, generation) ? remote : null;
  } catch (error) {
    if (submitting) await failJob(submitting, /^[a-z0-9_]+$/.test(error?.code || "") ? error.code : "provider_unavailable", generation);
    return null;
  } finally { activeAnalysisJobs.delete(job.jobID); }
}

async function pollAnalysis(job, generation = historyGeneration) {
  const settings = await getSettings();
  if (activeAnalysisJobs.has(job.jobID) || !settings.aiEnabled) return null;
  if ((job.origin ?? "manual") === "automatic" && !(await automaticJobSubmissionAllowed(job, settings))) return null;
  activeAnalysisJobs.add(job.jobID);
  let running;
  try {
    running = job.status === "running" ? job : transitionAnalysisJob(job, "running", { attempt: job.attempt + 1, nextPollAtMs: null }, Date.now());
    if (!(await putJobIfCurrent(running, generation))) return null;
    const currentSettings = await getSettings();
    if (!currentSettings.aiEnabled) return null;
    if ((job.origin ?? "manual") === "automatic" && !(await automaticJobSubmissionAllowed(job, currentSettings))) return null;
    const data = await fetchGemini(`${GEMINI_ENDPOINT}/${encodeURIComponent(job.providerJobID)}`, { method: "GET" }, await analysisKey());
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return null;
    const disposition = interactionDisposition(data);
    if (disposition === "failed") return failJob(running, classifyInteractionFailure(data), generation);
    if (disposition === "completed") {
      try {
        const result = analysisResultFromInteraction(data, running.jobID, Date.now());
        return result ? completeJob(running, result, generation) : failJob(running, "provider_response", generation);
      } catch {
        return failJob(running, "provider_response", generation);
      }
    }
    const remote = transitionAnalysisJob(running, "remote", { providerJobID: job.providerJobID, nextPollAtMs: Date.now() + 60_000 }, Date.now());
    return await putJobIfCurrent(remote, generation) ? remote : null;
  } catch (error) {
    if (running && running.attempt < 5 && ["provider_network", "provider_service_error", "provider_timeout"].includes(error?.code)) {
      const remote = transitionAnalysisJob(running, "remote", { providerJobID: job.providerJobID, nextPollAtMs: Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** running.attempt) }, Date.now());
      return await putJobIfCurrent(remote, generation) ? remote : null;
    }
    if (running) await failJob(running, /^[a-z0-9_]+$/.test(error?.code || "") ? error.code : "provider_unavailable", generation);
    return null;
  } finally { activeAnalysisJobs.delete(job.jobID); }
}

async function resumeAnalysisJobs() {
  const settings = await getSettings();
  if (!settings.aiEnabled) return;
  const nowMs = Date.now();
  for (const job of await repository.listAnalysisJobs()) {
    try {
      if ((job.origin ?? "manual") === "automatic" && !(await automaticJobSubmissionAllowed(job, settings, nowMs))) continue;
      const action = restartAction(job, nowMs);
      if (action === "submit") await submitAnalysis(job, historyGeneration);
      if (action === "poll" && job.providerJobID) await pollAnalysis(job, historyGeneration);
    } catch {}
  }
}

async function announceAnalysisReady(job, result, generation) {
  await withDataMutation(async () => {
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return;
    const stored = await localGet(ANALYSIS_SOURCES_KEY);
    const source = stored[ANALYSIS_SOURCES_KEY]?.[job.jobID] ?? null;
    const settings = await getSettings();
    if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return;
    await chrome.runtime.sendMessage({ type: "ANALYSIS_JOB_UPDATED", job: { ...job, result, source } }).catch(() => {});
    const nowMs = Date.now();
    if (!settings.aiEnabled || !interventionsAllowed(settings, nowMs)) return;
    const revision = settingsRevision;
    if (source?.tabId) {
      await chrome.tabs.sendMessage(source.tabId, { type: "SHOW_TOAST", text: "Your Watchwise analysis is ready.", actionLabel: "View summary", action: { type: "open_panel" } }, source.frameId !== undefined ? { frameId: source.frameId } : undefined).catch(() => {});
      if (revision !== settingsRevision || !interventionsAllowed(await getSettings(), Date.now())) {
        await chrome.tabs.sendMessage(source.tabId, { type: "HIDE_TOAST" }, source.frameId !== undefined ? { frameId: source.frameId } : undefined).catch(() => {});
      }
    }
  });
}

async function maybeStartAutomaticAnalysis(event, generation = historyGeneration) {
  let createdJob = null;
  await withDataMutation(async () => {
    if (generation !== historyGeneration) return;
    const settings = await getSettings();
    const revision = settingsRevision;
    const stored = await localGet([API_KEY, ANALYSIS_SOURCES_KEY]);
    const existingJobs = await repository.listAnalysisJobs();
    const recent = await repository.listEvents(event.occurredAtMs - 120_000, event.occurredAtMs + 1);
    const streamEvents = recent.filter((item) => item.sessionID === event.sessionID && item.tabID === event.tabID && item.frameID === event.frameID && item.playerID === event.playerID);
    const activeWatchedSeconds = activeSessionSeconds(streamEvents, event.occurredAtMs) ?? 0;
    const decision = automaticAnalysisEligibility({
      event,
      settings,
      apiKeyConfigured: typeof stored[API_KEY] === "string" && stored[API_KEY].length > 0,
      existingJobs,
      activeWatchedSeconds,
      nowMs: Date.now()
    });
    if (!decision.eligible || generation !== historyGeneration || revision !== settingsRevision) return;
    const job = createAnalysisJob({
      jobID: crypto.randomUUID(),
      url: decision.canonicalURL,
      mediaTitle: event.mediaTitle,
      origin: "automatic"
    });
    await repository.putAnalysisJob(job);
    if (generation !== historyGeneration || revision !== settingsRevision) return;
    await localSet({
      [ANALYSIS_SOURCES_KEY]: {
        ...(stored[ANALYSIS_SOURCES_KEY] || {}),
        [job.jobID]: {
          tabId: event.tabID,
          frameId: event.frameID,
          playerId: event.playerID,
          frameSite: event.frameSite,
          pageSite: event.pageSite
        }
      }
    });
    createdJob = job;
  });
  if (createdJob) void submitAnalysis(createdJob, generation);
  return createdJob;
}

async function automaticJobSubmissionAllowed(job, settings = null, nowMs = Date.now()) {
  const currentSettings = settings ?? await getSettings();
  const stored = await localGet([API_KEY, ANALYSIS_SOURCES_KEY]);
  const source = stored[ANALYSIS_SOURCES_KEY]?.[job.jobID] ?? null;
  return automaticSubmissionEligibility({
    job,
    settings: currentSettings,
    apiKeyConfigured: typeof stored[API_KEY] === "string" && stored[API_KEY].length > 0,
    source,
    nowMs
  }).eligible;
}

async function startAnalysis(rawURL, source = null) {
  const settings = await getSettings();
  if (!settings.aiEnabled) throw controlledError("AI_DISABLED");
  if (settings.movieModeUntilMs && settings.movieModeUntilMs > Date.now()) throw controlledError("MOVIE_MODE");
  const identity = youtubeVideoIdentity(canonicalizePublicURL(rawURL));
  if (!identity) throw controlledError("unsupported_analysis_site");
  const url = identity.canonicalURL;
  const site = "www.youtube.com";
  if (isExcludedSite(site, settings)) throw controlledError("SITE_EXCLUDED");
  const job = createAnalysisJob({ jobID: crypto.randomUUID(), url, mediaTitle: site, origin: "manual" });
  const generation = historyGeneration;
  let existingJob = null;
  const created = await withDataMutation(async () => {
    if (generation !== historyGeneration) return false;
    const existingJobs = await repository.listAnalysisJobs();
    const matching = existingJobs.filter((item) => youtubeVideoIdentity(item.url)?.videoKey === identity.videoKey && !["failed", "cancelled"].includes(item.status));
    const dormantAutomatic = matching.find((item) => (item.origin ?? "manual") === "automatic" && item.status === "queued" && item.attempt === 0 && !item.providerJobID);
    if (dormantAutomatic) {
      await repository.putAnalysisJob(transitionAnalysisJob(dormantAutomatic, "cancelled", { errorCode: "manual_override" }, Date.now()));
    }
    existingJob = matching.slice().reverse().find((item) => item !== dormantAutomatic) ?? null;
    if (existingJob) return false;
    await analysisKey();
    await repository.putAnalysisJob(job);
    return true;
  });
  if (existingJob) {
    const enriched = await enrichAnalysisJob(existingJob, generation);
    if (!enriched) throw new Error("history changed");
    return enriched;
  }
  if (!created) throw new Error("history changed");
  if (!source) {
    const recent = await repository.listEvents(Date.now() - RETENTION_MS, Date.now() + 1);
    const event = recent.filter((item) => youtubeVideoIdentity(item.url)?.videoKey === identity.videoKey).at(-1);
    if (event) source = { tabId: event.tabID, frameId: event.frameID, playerId: event.playerID };
  }
  if (source) {
    const sourceStored = await withDataMutation(async () => {
      if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return false;
      const stored = await localGet(ANALYSIS_SOURCES_KEY);
      if (generation !== historyGeneration || !(await repository.getAnalysisJob(job.jobID))) return false;
      await localSet({ [ANALYSIS_SOURCES_KEY]: { ...(stored[ANALYSIS_SOURCES_KEY] || {}), [job.jobID]: source } });
      return true;
    });
    if (!sourceStored) throw new Error("history changed");
  }
  void submitAnalysis(job, generation);
  return job;
}

async function seekTimestamp(message) {
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId) || typeof message.playerId !== "string" || !Number.isFinite(message.seconds)) throw new TypeError("invalid seek target");
  return chrome.tabs.sendMessage(message.tabId, { type: "SEEK_PLAYER", playerId: message.playerId, seconds: message.seconds }, { frameId: message.frameId });
}

async function openPanel() {
  const window = await chrome.windows.getLastFocused();
  if (!window?.id) throw new Error("No Chrome window");
  await chrome.sidePanel.open({ windowId: window.id });
}

async function handlePrivilegedMessage(message) {
  switch (message.type) {
    case "GET_DASHBOARD_STATE": return { ok: true, state: await getDashboardState() };
    case "COMPLETE_ONBOARDING": {
      const settings = await saveSettings({ trackingEnabled: message.trackingEnabled === true, aiEnabled: message.aiEnabled === true });
      await localSet({ [ONBOARDING_KEY]: true });
      return { ok: true, state: { ...(await getDashboardState()), settings } };
    }
    case "UPDATE_SETTINGS": return { ok: true, state: { ...(await getDashboardState()), settings: await saveSettings(message.patch) } };
    case "SAVE_API_KEY": {
      if (typeof message.key !== "string" || !message.key.trim() || message.key.length > 512) throw new TypeError("invalid key");
      await localSet({ [API_KEY]: message.key.trim() });
      return { ok: true };
    }
    case "CLEAR_API_KEY": await localRemove(API_KEY); return { ok: true };
    case "ANALYZE_URL": return { ok: true, job: await startAnalysis(message.url) };
    case "SEEK_TIMESTAMP": await seekTimestamp(message); return { ok: true };
    case "DELETE_HISTORY": {
      historyGeneration += 1;
      await withDataMutation(async () => {
        sessions.clear();
        await repository.deleteAll();
        await localSet({ [ANALYSIS_SOURCES_KEY]: {}, [NUDGE_STATE_KEY]: {}, [GOAL_CHECK_STATE_KEY]: {} });
      });
      await announceDashboardUpdated({ immediate: true });
      return { ok: true };
    }
    case "OPEN_SIDE_PANEL": await openPanel(); return { ok: true };
    default: throw new TypeError("unsupported privileged message");
  }
}

const initializationPromise = setInitialState();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await initializationPromise;
    if (message?.type === "DASHBOARD_UPDATED") return { ok: true };
    if (message?.type === "CONTENT_HEALTH_CHECK") return {
      ok: message.lifecycle === CONTENT_LIFECYCLE,
      lifecycle: CONTENT_LIFECYCLE
    };
    if (message?.type === "CONTENT_READY") {
      const state = await trackingStateForSender(sender);
      if (sender.frameId === 0 && state.enabled) void announceDashboardUpdated();
      return { ok: true, ...state };
    }
    if (message?.type === "PLAYBACK_EVENT") return { ok: true, ...(await ingestPlayback(message.event, sender)) };
    if (message?.type === "TOAST_ACTION") {
      if (message.action?.type === "open_panel") await openPanel();
      else if (message.action?.type === "seek") {
        const context = frameContext(sender);
        await seekTimestamp({ tabId: context.tabID, frameId: context.frameID, playerId: message.action.playerId, seconds: Number(message.action.seconds) });
      } else throw new TypeError("invalid toast action");
      return { ok: true };
    }
    if (!isExtensionPage(sender)) throw new TypeError("privileged sender required");
    return handlePrivilegedMessage(message);
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: publicError(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => { void initializationPromise.then(recoverExistingContentScripts).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => {
  void initializationPromise.then(async () => {
    await recoverExistingContentScripts();
    await resumeAnalysisJobs();
  }).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void initializationPromise.then(async () => {
    const tab = await chrome.tabs.get(tabId);
    const settings = await getSettings();
    if (!(await recoverContentScriptInTab(tab, settings))) return;
    await announceDashboardUpdated({ immediate: true });
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ANALYSIS_ALARM) void resumeAnalysisJobs();
  if (alarm.name === INSIGHTS_ALARM) void announceDashboardUpdated();
  if (alarm.name === PRUNE_ALARM) void pruneRetainedData(Date.now() - RETENTION_MS).catch(() => {});
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
void initializationPromise.then(recoverExistingContentScripts).catch(() => {});
void initializationPromise.catch(() => {});
