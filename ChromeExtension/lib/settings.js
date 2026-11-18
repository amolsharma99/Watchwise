import { normalizeHostname } from "./validation.js";

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  trackingEnabled: false,
  notificationsEnabled: false,
  aiEnabled: false,
  autoAnalysisEnabled: true,
  excludedSites: Object.freeze([]),
  movieModeUntilMs: null,
  snoozedUntilMs: null,
  quietHoursEnabled: false,
  quietHoursStartMinute: 22 * 60,
  quietHoursEndMinute: 8 * 60,
  dailyLimitSeconds: 60 * 60,
  longSessionSeconds: 25 * 60
});

function boolean(value, fallback) { return typeof value === "boolean" ? value : fallback; }
function bounded(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
function futureOrNull(value) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }

/** Unknown properties (including API keys) are intentionally discarded. */
export function normalizeSettings(input = {}) {
  const rawExcluded = Array.isArray(input.excludedSites) ? input.excludedSites : [];
  const excludedSites = [...new Set(rawExcluded.map((site) => {
    try { return normalizeHostname(site); } catch { return null; }
  }).filter(Boolean))].sort();
  return Object.freeze({
    schemaVersion: 1,
    trackingEnabled: boolean(input.trackingEnabled, false),
    notificationsEnabled: boolean(input.notificationsEnabled, false),
    aiEnabled: boolean(input.aiEnabled, false),
    autoAnalysisEnabled: boolean(input.autoAnalysisEnabled, true),
    excludedSites: Object.freeze(excludedSites),
    movieModeUntilMs: futureOrNull(input.movieModeUntilMs),
    snoozedUntilMs: futureOrNull(input.snoozedUntilMs),
    quietHoursEnabled: boolean(input.quietHoursEnabled, false),
    quietHoursStartMinute: Math.trunc(bounded(input.quietHoursStartMinute, DEFAULT_SETTINGS.quietHoursStartMinute, 0, 1439)),
    quietHoursEndMinute: Math.trunc(bounded(input.quietHoursEndMinute, DEFAULT_SETTINGS.quietHoursEndMinute, 0, 1439)),
    dailyLimitSeconds: bounded(input.dailyLimitSeconds, DEFAULT_SETTINGS.dailyLimitSeconds, 5 * 60, 12 * 60 * 60),
    longSessionSeconds: bounded(input.longSessionSeconds, DEFAULT_SETTINGS.longSessionSeconds, 5 * 60, 4 * 60 * 60)
  });
}

export function isExcludedSite(site, settings) {
  const host = normalizeHostname(site);
  return normalizeSettings(settings).excludedSites.some((excluded) => host === excluded || host.endsWith(`.${excluded}`));
}

export function isQuietTime(nowMs, settings, offsetMinutes = -new Date(nowMs).getTimezoneOffset()) {
  const normalized = normalizeSettings(settings);
  if (!normalized.quietHoursEnabled || normalized.quietHoursStartMinute === normalized.quietHoursEndMinute) return false;
  const local = new Date(nowMs + offsetMinutes * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const { quietHoursStartMinute: start, quietHoursEndMinute: end } = normalized;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function safeSettingsExport(settings) {
  return JSON.parse(JSON.stringify(normalizeSettings(settings)));
}
