import { IndexedDBRepository, isSecureStorageError } from "./lib/storage.js";
import { NudgeEngine, distinctSessionsInWindow } from "./lib/nudges.js";
import { activeSessionSeconds, dayWindow, summarizeViewing, weekWindow } from "./lib/insights.js";
import {
  completeGoalCheckInReservation,
  deliverGoalCheckIn,
  evaluateGoalCheckIn,
  failGoalCheckInReservation,
  GOAL_CHECKIN_MIN_GAP_MS,
  isGoalPlaybackActive
} from "./lib/goal-checkin.js";
import { isExcludedSite, isQuietTime, normalizeSettings } from "./lib/settings.js";
import { normalizeHostname, playbackStreamKey, validatePlaybackEvent } from "./lib/validation.js";
import { isUnidentifiedYouTubeURL } from "./lib/youtube.js";

const SETTINGS_KEY = "watchwiseSettings";
const ONBOARDING_KEY = "onboardingComplete";
const NUDGE_STATE_KEY = "nudgeState";
const GOAL_CHECK_STATE_KEY = "goalCheckInState";
const SESSION_GAP_MS = 10 * 60_000;
const RETENTION_MS = 180 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const DASHBOARD_UPDATE_INTERVAL_MS = 1_000;
const CONTENT_LIFECYCLE = "watchwise-tracker-v0.3.9";
const repository = new IndexedDBRepository();
const sessions = new Map();
let historyGeneration = 0;
let dataMutationQueue = Promise.resolve();
let settingsRevision = 0;
let dashboardUpdateTimer = null;
let lastDashboardUpdateAtMs = 0;
let contentRecoveryPromise = null;

function withDataMutation(operation) {
  const run = dataMutationQueue.then(operation, operation);
  dataMutationQueue = run.catch(() => {});
  return run;
}

const STATE_FIELDS = Object.freeze({
  [SETTINGS_KEY]: "settings",
  [ONBOARDING_KEY]: "onboardingComplete",
  [NUDGE_STATE_KEY]: "nudgeState",
  [GOAL_CHECK_STATE_KEY]: "goalCheckInState"
});
async function localGet(keys) {
  const state = await repository.getState();
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(requested.map((key) => [key, state[STATE_FIELDS[key]]]));
}
async function localSet(values) {
  const current = await repository.getState();
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) {
    const field = STATE_FIELDS[key];
    if (!field) throw new TypeError("unknown secure state field");
    next[field] = value;
  }
  await repository.setState(next);
}
function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function publicError(error) {
  if (error?.name === "ValidationError") return "That value is not valid or allowed.";
  return "Watchwise could not complete that action.";
}

async function getSettings() {
  const stored = await localGet(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("invalid settings patch");
  const allowed = new Set([
    "trackingEnabled", "notificationsEnabled", "excludedSites",
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

async function completeOnboarding(trackingEnabled) {
  let settings;
  await withDataMutation(async () => {
    const state = await repository.getState();
    settings = normalizeSettings({ ...state.settings, trackingEnabled: trackingEnabled === true });
    settingsRevision += 1;
    await repository.setState({ ...state, settings, onboardingComplete: true });
  });
  await broadcastTrackingState();
  if (settings.trackingEnabled) void recoverExistingContentScripts(settings);
  return settings;
}

async function setInitialState() {
  await repository.open();
  const state = await repository.getState();
  await repository.setState({ ...state, settings: normalizeSettings(state.settings), onboardingComplete: state.onboardingComplete === true });
  try { await maybePrune(Date.now()); } catch {}
}

async function maybePrune(nowMs = Date.now()) {
  await withDataMutation(async () => {
    const state = await repository.getState();
    if (nowMs - (state.maintenance?.lastPruneAtMs || 0) < PRUNE_INTERVAL_MS) return;
    await repository.prune(nowMs - RETENTION_MS);
    await repository.setState({ ...state, maintenance: { lastPruneAtMs: nowMs } });
  });
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
  void maybePrune().catch(() => {});
  if (["playing", "heartbeat"].includes(event.state)) {
    const deliveredGoalCheckIn = await maybeGoalCheckIn(event, generation);
    if (!deliveredGoalCheckIn) await maybeNudge(event, generation);
  }
  return { accepted: true };
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
      reservation = { generation, revision, ...decision.reservation, message: decision.message };
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
  const delivered = await deliverGoalCheckIn({ browser: chrome, event, isAllowed: stillAllowed, message: reservation.message });
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
      positionSeconds: event.positionSeconds
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
      actionLabel: "Open Watchwise",
      action: { type: "open_panel" }
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
  const stored = await localGet(ONBOARDING_KEY);
  let activeTab = null;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {}
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    onboardingComplete: stored[ONBOARDING_KEY] === true,
    settings,
    today: summarizeViewing(events, todayRange, { nowMs }),
    week: summarizeViewing(events, weekRange, { nowMs }),
    previousWeekActiveSeconds: summarizeViewing(events, previousWeek).activeSeconds,
    trackingConnection: await activeTabTrackingConnection(activeTab, settings)
  };
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
      const settings = await completeOnboarding(message.trackingEnabled);
      return { ok: true, state: { ...(await getDashboardState()), settings } };
    }
    case "UPDATE_SETTINGS": return { ok: true, state: { ...(await getDashboardState()), settings: await saveSettings(message.patch) } };
    case "DELETE_HISTORY": {
      historyGeneration += 1;
      await withDataMutation(async () => {
        sessions.clear();
        await repository.deleteAll();
        await localSet({ [NUDGE_STATE_KEY]: {}, [GOAL_CHECK_STATE_KEY]: {} });
      });
      await announceDashboardUpdated({ immediate: true });
      return { ok: true };
    }
    case "OPEN_SIDE_PANEL": await openPanel(); return { ok: true };
    default: throw new TypeError("unsupported privileged message");
  }
}

let initializationPromise = setInitialState();

async function resetSecureStorage() {
  historyGeneration += 1;
  settingsRevision += 1;
  await withDataMutation(async () => {
    sessions.clear();
    await repository.resetSecureStorage();
  });
  initializationPromise = setInitialState();
  await initializationPromise;
  await Promise.allSettled([broadcastTrackingState(), clearInterventions(), announceDashboardUpdated({ immediate: true })]);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "RESET_SECURE_STORAGE") {
      if (!isExtensionPage(sender)) throw new TypeError("privileged sender required");
      await resetSecureStorage();
      return { ok: true };
    }
    try {
      await initializationPromise;
    } catch {
      if (isExtensionPage(sender)) return {
        ok: false,
        code: "secure_storage_unavailable",
        error: "Encrypted local data could not be opened. Reset Watchwise local data to continue."
      };
      throw new Error("Secure local storage is unavailable");
    }
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
      else throw new TypeError("invalid toast action");
      return { ok: true };
    }
    if (!isExtensionPage(sender)) throw new TypeError("privileged sender required");
    return handlePrivilegedMessage(message);
  })().then(sendResponse).catch((error) => sendResponse(isExtensionPage(sender) && isSecureStorageError(error)
    ? {
        ok: false,
        code: "secure_storage_unavailable",
        error: "Encrypted local data could not be opened. Reset Watchwise local data to continue."
      }
    : { ok: false, error: publicError(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => { void initializationPromise.then(recoverExistingContentScripts).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => {
  void initializationPromise.then(async () => {
    await recoverExistingContentScripts();
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
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
void initializationPromise.then(recoverExistingContentScripts).catch(() => {});
void initializationPromise.catch(() => {});
