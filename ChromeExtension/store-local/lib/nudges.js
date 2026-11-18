import { isExcludedSite, isQuietTime, normalizeSettings } from "./settings.js";

export const NUDGE_KINDS = Object.freeze({ DAILY_LIMIT: "daily_limit", LONG_SESSION: "long_session", RABBIT_HOLE: "rabbit_hole" });

export class NudgeEngine {
  constructor({ cooldownMs = 10 * 60_000, hourlyLimit = 3, emittedAtMs = [] } = {}) {
    this.cooldownMs = Math.max(0, cooldownMs);
    this.hourlyLimit = Math.max(1, Math.trunc(hourlyLimit));
    this.emittedAtMs = emittedAtMs.filter(Number.isFinite).sort((a, b) => a - b);
  }

  evaluate(context, rawSettings, offsetMinutes) {
    const settings = normalizeSettings(rawSettings);
    const nowMs = context.nowMs;
    if (!settings.trackingEnabled) return this.#suppressed("tracking_off");
    if (!settings.notificationsEnabled) return this.#suppressed("notifications_off");
    if (isExcludedSite(context.pageSite, settings)) return this.#suppressed("site_excluded");
    if (settings.movieModeUntilMs && settings.movieModeUntilMs > nowMs) return this.#suppressed("movie_mode");
    if (settings.snoozedUntilMs && settings.snoozedUntilMs > nowMs) return this.#suppressed("snoozed");
    if (isQuietTime(nowMs, settings, offsetMinutes)) return this.#suppressed("quiet_hours");
    this.emittedAtMs = this.emittedAtMs.filter((value) => nowMs - value < 60 * 60_000 && value <= nowMs);
    const latest = this.emittedAtMs.at(-1);
    if (Number.isFinite(latest) && nowMs - latest < this.cooldownMs) return this.#suppressed("cooldown");
    if (this.emittedAtMs.length >= this.hourlyLimit) return this.#suppressed("hourly_limit");
    let nudge = null;
    if (context.dailyActiveSeconds >= settings.dailyLimitSeconds) nudge = this.#nudge(NUDGE_KINDS.DAILY_LIMIT, "Daily viewing target reached", "You’ve reached today’s viewing target. Pause, or continue intentionally.", nowMs);
    else if (context.distinctSessionsLast20Minutes >= 5) nudge = this.#nudge(NUDGE_KINDS.RABBIT_HOLE, "A quick check-in", "You’ve opened several videos recently. Is the next one still serving your goal?", nowMs);
    else if (context.activeSessionSeconds >= settings.longSessionSeconds) nudge = this.#nudge(NUDGE_KINDS.LONG_SESSION, "Still worth your time?", "You’ve been watching continuously. Take a breath, or keep going intentionally.", nowMs);
    if (nudge) this.emittedAtMs.push(nowMs);
    return Object.freeze({ nudge, suppression: null });
  }

  exportState() { return Object.freeze({ schemaVersion: 1, cooldownMs: this.cooldownMs, hourlyLimit: this.hourlyLimit, emittedAtMs: [...this.emittedAtMs] }); }
  #nudge(kind, title, message, nowMs) { return Object.freeze({ kind, title, message, createdAtMs: nowMs, suggestedTimestampSeconds: null }); }
  #suppressed(suppression) { return Object.freeze({ nudge: null, suppression }); }
}

export function distinctSessionsInWindow(events, nowMs, durationMs = 20 * 60_000) {
  return new Set(events.filter((event) => event.occurredAtMs >= nowMs - durationMs && event.occurredAtMs <= nowMs).map((event) => event.sessionID)).size;
}
