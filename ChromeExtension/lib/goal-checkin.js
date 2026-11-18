import { youtubeVideoIdentity } from "./auto-analysis.js";
import { isExcludedSite, isQuietTime, normalizeSettings } from "./settings.js";
import { playbackStreamKey } from "./validation.js";

export const GOAL_CHECKIN_MESSAGE = "Hope you’re clear on your goal for watching this video.";
export const GOAL_CHECKIN_THRESHOLD_SECONDS = 15;
export const GOAL_CHECKIN_MIN_GAP_MS = 60_000;

const PLAYING_STATES = new Set(["playing", "heartbeat", "rate_changed"]);
const PROCESSED_RETENTION_MS = 24 * 60 * 60_000;
const MAX_PROCESSED_IDENTITIES = 200;
const MAX_PENDING_IDENTITIES = 20;
const RESERVATION_LEASE_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BASE_MS = 5_000;

export function goalCheckInIdentity(event) {
  return youtubeVideoIdentity(event?.url)?.videoKey ?? `session:${event?.sessionID ?? ""}`;
}

export function isGoalPlaybackActive(events, targetEvent, nowMs = Date.now(), freshnessMs = 30_000) {
  const targetKey = playbackStreamKey(targetEvent);
  const latest = events.filter((event) => playbackStreamKey(event) === targetKey && event.occurredAtMs <= nowMs)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID)).at(-1);
  return Boolean(latest
    && ["playing", "heartbeat"].includes(latest.state)
    && latest.isVisible && latest.isTabActive
    && nowMs >= latest.occurredAtMs && nowMs - latest.occurredAtMs <= freshnessMs);
}

function unionSeconds(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let totalMs = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) current = [...interval];
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { totalMs += current[1] - current[0]; current = [...interval]; }
  }
  if (current) totalMs += current[1] - current[0];
  return totalMs / 1_000;
}

export function meaningfulGoalPlaybackSeconds(events, targetEvent) {
  const identity = goalCheckInIdentity(targetEvent);
  const streams = new Map();
  for (const event of events) {
    if (goalCheckInIdentity(event) !== identity) continue;
    if (youtubeVideoIdentity(targetEvent.url) && event.tabID !== targetEvent.tabID) continue;
    const key = playbackStreamKey(event);
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(event);
  }
  const intervals = [];
  for (const stream of streams.values()) {
    stream.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID));
    for (let index = 0; index + 1 < stream.length; index += 1) {
      const previous = stream[index];
      const next = stream[index + 1];
      if (!PLAYING_STATES.has(previous.state) || !previous.isVisible || !previous.isTabActive) continue;
      const wallSeconds = (next.occurredAtMs - previous.occurredAtMs) / 1_000;
      const mediaDelta = next.positionSeconds - previous.positionSeconds;
      if (wallSeconds <= 0 || wallSeconds > 120 || mediaDelta <= 0) continue;
      if (mediaDelta > wallSeconds * previous.playbackRate * 1.5 + 2) continue;
      const meaningfulSeconds = Math.min(wallSeconds, mediaDelta / Math.max(previous.playbackRate, 0.25));
      if (meaningfulSeconds > 0) intervals.push([previous.occurredAtMs, previous.occurredAtMs + meaningfulSeconds * 1_000]);
    }
  }
  const ordered = intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const clusters = [];
  for (const interval of ordered) {
    const cluster = clusters.at(-1);
    if (!cluster || interval[0] - cluster.endMs > 30_000) clusters.push({ endMs: interval[1], intervals: [interval] });
    else {
      cluster.endMs = Math.max(cluster.endMs, interval[1]);
      cluster.intervals.push(interval);
    }
  }
  const latestCluster = clusters.at(-1);
  if (!latestCluster || targetEvent.occurredAtMs - latestCluster.endMs > 30_000) return 0;
  return unionSeconds(latestCluster.intervals);
}

function normalizedState(rawState, nowMs) {
  if (rawState?.schemaVersion !== 2) return { schemaVersion: 2, processed: [], pending: [], lastInterventionAtMs: null };
  const processed = Array.isArray(rawState?.processed) ? rawState.processed.filter((entry) => (
    entry && typeof entry.identity === "string" && entry.identity.length <= 256 && Number.isFinite(entry.processedAtMs)
      && entry.processedAtMs <= nowMs && nowMs - entry.processedAtMs < PROCESSED_RETENTION_MS
  )).slice(-MAX_PROCESSED_IDENTITIES) : [];
  const lastInterventionAtMs = Number.isFinite(rawState?.lastInterventionAtMs) && rawState.lastInterventionAtMs <= nowMs
    ? rawState.lastInterventionAtMs : null;
  const pending = Array.isArray(rawState?.pending) ? rawState.pending.filter((entry) => (
    entry && typeof entry.identity === "string" && entry.identity.length <= 256
      && Number.isFinite(entry.reservedAtMs) && Number.isFinite(entry.retryAtMs)
      && Number.isInteger(entry.attempts) && entry.attempts >= 0 && entry.attempts < MAX_DELIVERY_ATTEMPTS
      && entry.reservedAtMs <= nowMs
  )).slice(-MAX_PENDING_IDENTITIES) : [];
  return { schemaVersion: 2, processed, pending, lastInterventionAtMs };
}

function suppressionReason(event, rawSettings, nowMs, offsetMinutes) {
  const settings = normalizeSettings(rawSettings);
  if (!settings.trackingEnabled) return "tracking_off";
  if (!settings.notificationsEnabled) return "notifications_off";
  if (isExcludedSite(event.pageSite, settings) || isExcludedSite(event.frameSite, settings)) return "site_excluded";
  if (settings.movieModeUntilMs > nowMs) return "movie_mode";
  if (settings.snoozedUntilMs > nowMs) return "snoozed";
  if (isQuietTime(nowMs, settings, offsetMinutes)) return "quiet_hours";
  return null;
}

export function evaluateGoalCheckIn({ events, event, settings, state = {}, nowMs = Date.now(), offsetMinutes = undefined, lastInterventionAtMs = null }) {
  const nextState = normalizedState(state, nowMs);
  const identity = goalCheckInIdentity(event);
  if (!PLAYING_STATES.has(event.state) || !event.isVisible || !event.isTabActive) {
    return Object.freeze({ shouldPrompt: false, crossedThreshold: false, suppression: "not_active", identity, meaningfulSeconds: 0, state: Object.freeze(nextState) });
  }
  if (nextState.processed.some((entry) => entry.identity === identity)) {
    return Object.freeze({ shouldPrompt: false, crossedThreshold: true, suppression: "already_processed", identity, meaningfulSeconds: 0, state: Object.freeze(nextState) });
  }
  const meaningfulSeconds = meaningfulGoalPlaybackSeconds(events, event);
  if (meaningfulSeconds < GOAL_CHECKIN_THRESHOLD_SECONDS) {
    return Object.freeze({ shouldPrompt: false, crossedThreshold: false, suppression: "threshold", identity, meaningfulSeconds, state: Object.freeze(nextState) });
  }
  const suppression = suppressionReason(event, settings, nowMs, offsetMinutes);
  if (suppression) {
    nextState.processed = [...nextState.processed, { identity, processedAtMs: nowMs }].slice(-MAX_PROCESSED_IDENTITIES);
    nextState.pending = nextState.pending.filter((entry) => entry.identity !== identity);
    return Object.freeze({ shouldPrompt: false, crossedThreshold: true, suppression, identity, meaningfulSeconds, state: Object.freeze(nextState) });
  }
  const latest = Math.max(
    Number.isFinite(nextState.lastInterventionAtMs) ? nextState.lastInterventionAtMs : -Infinity,
    Number.isFinite(lastInterventionAtMs) ? lastInterventionAtMs : -Infinity
  );
  if (Number.isFinite(latest) && nowMs - latest < GOAL_CHECKIN_MIN_GAP_MS) {
    return Object.freeze({ shouldPrompt: false, crossedThreshold: true, suppression: "cadence", identity, meaningfulSeconds, state: Object.freeze(nextState) });
  }
  const existingPending = nextState.pending.find((entry) => entry.identity === identity);
  if (existingPending && nowMs < existingPending.retryAtMs) {
    return Object.freeze({ shouldPrompt: false, crossedThreshold: true, suppression: "pending", identity, meaningfulSeconds, state: Object.freeze(nextState) });
  }
  const reservation = {
    identity,
    reservedAtMs: nowMs,
    retryAtMs: nowMs + RESERVATION_LEASE_MS,
    attempts: existingPending?.attempts ?? 0
  };
  nextState.pending = [...nextState.pending.filter((entry) => entry.identity !== identity), reservation].slice(-MAX_PENDING_IDENTITIES);
  return Object.freeze({
    shouldPrompt: true,
    crossedThreshold: true,
    suppression: null,
    identity,
    reservation,
    meaningfulSeconds,
    message: GOAL_CHECKIN_MESSAGE,
    state: Object.freeze(nextState)
  });
}

export function completeGoalCheckInReservation(rawState, reservation, nowMs = Date.now()) {
  const state = normalizedState(rawState, nowMs);
  const pending = state.pending.find((entry) => entry.identity === reservation?.identity && entry.reservedAtMs === reservation?.reservedAtMs);
  if (!pending) return Object.freeze(state);
  state.pending = state.pending.filter((entry) => entry !== pending);
  state.processed = [...state.processed, { identity: pending.identity, processedAtMs: nowMs }].slice(-MAX_PROCESSED_IDENTITIES);
  state.lastInterventionAtMs = nowMs;
  return Object.freeze(state);
}

export function failGoalCheckInReservation(rawState, reservation, nowMs = Date.now()) {
  const state = normalizedState(rawState, nowMs);
  const pending = state.pending.find((entry) => entry.identity === reservation?.identity && entry.reservedAtMs === reservation?.reservedAtMs);
  if (!pending) return Object.freeze(state);
  const attempts = pending.attempts + 1;
  state.pending = state.pending.filter((entry) => entry !== pending);
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    state.processed = [...state.processed, { identity: pending.identity, processedAtMs: nowMs }].slice(-MAX_PROCESSED_IDENTITIES);
  } else {
    state.pending.push({
      identity: pending.identity,
      reservedAtMs: nowMs,
      retryAtMs: nowMs + RETRY_BASE_MS * (2 ** (attempts - 1)),
      attempts
    });
  }
  return Object.freeze(state);
}

export async function deliverGoalCheckIn({ browser, event, isAllowed }) {
  if (!(await isAllowed())) return false;
  let toastDelivered = false;
  try {
    const response = await browser.tabs.sendMessage(event.tabID, { type: "SHOW_TOAST", text: GOAL_CHECKIN_MESSAGE, priority: "goal_checkin" }, { frameId: event.frameID });
    toastDelivered = response?.shown === true;
  } catch {}
  if (!toastDelivered) return false;
  if (!(await isAllowed())) {
    if (toastDelivered) await browser.tabs.sendMessage(event.tabID, { type: "HIDE_TOAST" }, { frameId: event.frameID }).catch(() => {});
    return false;
  }

  const notificationID = `nudge:goal:${event.eventID}`;
  let notificationDelivered = false;
  try {
    await browser.notifications.create(notificationID, {
      type: "basic",
      iconUrl: browser.runtime.getURL("assets/icon128.png"),
      title: "Watchwise check-in",
      message: GOAL_CHECKIN_MESSAGE,
      priority: 0
    });
    notificationDelivered = true;
  } catch {}
  if (!(await isAllowed())) {
    if (notificationDelivered) await browser.notifications.clear(notificationID).catch(() => {});
    if (toastDelivered) await browser.tabs.sendMessage(event.tabID, { type: "HIDE_TOAST" }, { frameId: event.frameID }).catch(() => {});
    return false;
  }
  return toastDelivered || notificationDelivered;
}
