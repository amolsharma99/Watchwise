import { isExcludedSite, isQuietTime, normalizeSettings } from "./settings.js";

export const NUDGE_KINDS = Object.freeze({
  DAILY_LIMIT: "daily_limit",
  LONG_SESSION: "long_session",
  RABBIT_HOLE: "rabbit_hole",
  INCREASE_SPEED: "increase_speed",
  SKIP_TO_MAIN_POINT: "skip_to_main_point"
});

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
    const latest = this.emittedAtMs[this.emittedAtMs.length - 1];
    if (Number.isFinite(latest) && nowMs - latest < this.cooldownMs) return this.#suppressed("cooldown");
    if (this.emittedAtMs.length >= this.hourlyLimit) return this.#suppressed("hourly_limit");

    let nudge = null;
    if (context.dailyActiveSeconds >= settings.dailyLimitSeconds) {
      nudge = this.#nudge(NUDGE_KINDS.DAILY_LIMIT, "Daily viewing target reached", "You’ve reached today’s viewing target. Pause, or continue intentionally.", nowMs);
    } else if (context.distinctSessionsLast20Minutes >= 5) {
      nudge = this.#nudge(NUDGE_KINDS.RABBIT_HOLE, "A quick check-in", "You’ve opened several videos recently. Is the next one still serving your goal?", nowMs);
    } else if (context.activeSessionSeconds >= settings.longSessionSeconds) {
      nudge = this.#nudge(NUDGE_KINDS.LONG_SESSION, "Still worth your time?", "You’ve been watching continuously. Take a breath, or keep going intentionally.", nowMs);
    } else {
      nudge = this.#aiNudge(context, nowMs);
    }
    if (nudge) this.emittedAtMs.push(nowMs);
    return Object.freeze({ nudge, suppression: null });
  }

  exportState() {
    return Object.freeze({ schemaVersion: 1, cooldownMs: this.cooldownMs, hourlyLimit: this.hourlyLimit, emittedAtMs: [...this.emittedAtMs] });
  }

  #aiNudge(context, nowMs) {
    const evidence = context.aiEvidence;
    if (!evidence || evidence.source !== "validated_analysis" || !Number.isFinite(evidence.confidence) || evidence.confidence < 0.6) return null;
    if (evidence.lowInformationSignal !== true || typeof evidence.evidenceText !== "string" || evidence.evidenceText.trim().length < 3) return null;
    if (Number.isFinite(evidence.skipTimestampSeconds) && evidence.skipTimestampSeconds > context.positionSeconds + 5) {
      return this.#nudge(
        NUDGE_KINDS.SKIP_TO_MAIN_POINT,
        "The main section may be ahead",
        "The analysis found a lower-information section. You can jump ahead, or keep watching for context.",
        nowMs,
        evidence.skipTimestampSeconds
      );
    }
    if (context.playbackRate <= 1) {
      return this.#nudge(
        NUDGE_KINDS.INCREASE_SPEED,
        "Try a slightly faster pace?",
        "Analysis suggests this section is less dense. Consider 1.25× only if it still feels comfortable.",
        nowMs
      );
    }
    return null;
  }

  #nudge(kind, title, message, nowMs, suggestedTimestampSeconds = null) {
    return Object.freeze({ kind, title, message, createdAtMs: nowMs, suggestedTimestampSeconds });
  }

  #suppressed(suppression) { return Object.freeze({ nudge: null, suppression }); }
}

export function distinctSessionsInWindow(events, nowMs, durationMs = 20 * 60_000) {
  return new Set(events.filter((event) => event.occurredAtMs >= nowMs - durationMs && event.occurredAtMs <= nowMs).map((event) => event.sessionID)).size;
}
