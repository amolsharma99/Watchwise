import { isExcludedSite, isQuietTime, normalizeSettings } from "./settings.js";

export const NUDGE_KINDS = Object.freeze({ DAILY_LIMIT: "daily_limit", LONG_SESSION: "long_session", RABBIT_HOLE: "rabbit_hole" });

function nudgeCopy(kind, context) {
  const isYouTube = /(?:^|\.)youtube\.com$/.test(String(context.pageSite || ""));
  if (kind === NUDGE_KINDS.DAILY_LIMIT) return isYouTube
    ? ["The algorithm wants an encore 🎬", "Your viewing target is done. Please leave if the next video isn't giving you what you came for."]
    : ["Your time is asking for a turn 🌱", "You've reached your viewing target. If this isn't valuable, please close it and take your time back."];
  if (kind === NUDGE_KINDS.RABBIT_HOLE) return ["The feed has momentum 👀", "A few videos in a row. Please choose your next step, or close the tab and reclaim it."];
  if (kind === NUDGE_KINDS.LONG_SESSION) return ["Still worth staying? ⏳", "You've been here a while. If the useful part is over, please let yourself leave."];
  return ["A quick check-in", "Is this still helping with your plan?"];
}

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
    if (context.dailyActiveSeconds >= settings.dailyLimitSeconds) nudge = this.#contextNudge(NUDGE_KINDS.DAILY_LIMIT, context, nowMs);
    else if (context.distinctSessionsLast20Minutes >= 5) nudge = this.#contextNudge(NUDGE_KINDS.RABBIT_HOLE, context, nowMs);
    else if (context.activeSessionSeconds >= settings.longSessionSeconds) nudge = this.#contextNudge(NUDGE_KINDS.LONG_SESSION, context, nowMs);
    if (nudge) this.emittedAtMs.push(nowMs);
    return Object.freeze({ nudge, suppression: null });
  }

  exportState() { return Object.freeze({ schemaVersion: 1, cooldownMs: this.cooldownMs, hourlyLimit: this.hourlyLimit, emittedAtMs: [...this.emittedAtMs] }); }
  #nudge(kind, title, message, nowMs) { return Object.freeze({ kind, title, message, createdAtMs: nowMs }); }
  #contextNudge(kind, context, nowMs) { const [title, message] = nudgeCopy(kind, context); return this.#nudge(kind, title, message, nowMs); }
  #suppressed(suppression) { return Object.freeze({ nudge: null, suppression }); }
}

export function distinctSessionsInWindow(events, nowMs, durationMs = 20 * 60_000) {
  return new Set(events.filter((event) => event.occurredAtMs >= nowMs - durationMs && event.occurredAtMs <= nowMs).map((event) => event.sessionID)).size;
}
