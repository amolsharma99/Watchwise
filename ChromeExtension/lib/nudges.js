import { isExcludedSite, isQuietTime, normalizeSettings } from "./settings.js";

export const NUDGE_KINDS = Object.freeze({
  DAILY_LIMIT: "daily_limit",
  LONG_SESSION: "long_session",
  RABBIT_HOLE: "rabbit_hole",
  INCREASE_SPEED: "increase_speed",
  SKIP_TO_MAIN_POINT: "skip_to_main_point"
});

function nudgeCopy(kind, context) {
  const minutes = Math.max(1, Math.floor(context.dailyActiveSeconds / 60));
  const sessionMinutes = Math.max(1, Math.floor(context.activeSessionSeconds / 60));
  const isYouTube = /(?:^|\.)youtube\.com$/.test(String(context.pageSite || ""));
  if (kind === NUDGE_KINDS.DAILY_LIMIT) {
    return isYouTube
      ? ["You have watched about " + minutes + " minutes today.", "The algorithm has a sequel ready. Your daily target says this is a fine place for credits."]
      : ["Your viewing target has clocked out.", "You have watched about " + minutes + " minutes today. Want to join it?"];
  }
  if (kind === NUDGE_KINDS.RABBIT_HOLE) {
    return ["The video parade is growing.", "A few videos in quick succession. Was there one thing you came to find?"];
  }
  if (kind === NUDGE_KINDS.LONG_SESSION) {
    return ["Still on the clock?", "About " + sessionMinutes + " minutes in this stretch. This video has had its audition; is it still worth your time?"];
  }
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
    const latest = this.emittedAtMs[this.emittedAtMs.length - 1];
    if (Number.isFinite(latest) && nowMs - latest < this.cooldownMs) return this.#suppressed("cooldown");
    if (this.emittedAtMs.length >= this.hourlyLimit) return this.#suppressed("hourly_limit");

    let nudge = null;
    if (context.dailyActiveSeconds >= settings.dailyLimitSeconds) {
      nudge = this.#contextNudge(NUDGE_KINDS.DAILY_LIMIT, context, nowMs);
    } else if (context.distinctSessionsLast20Minutes >= 5) {
      nudge = this.#contextNudge(NUDGE_KINDS.RABBIT_HOLE, context, nowMs);
    } else if (context.activeSessionSeconds >= settings.longSessionSeconds) {
      nudge = this.#contextNudge(NUDGE_KINDS.LONG_SESSION, context, nowMs);
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

  #contextNudge(kind, context, nowMs) {
    const [title, message] = nudgeCopy(kind, context);
    return this.#nudge(kind, title, message, nowMs);
  }

  #suppressed(suppression) { return Object.freeze({ nudge: null, suppression }); }
}

export function distinctSessionsInWindow(events, nowMs, durationMs = 20 * 60_000) {
  return new Set(events.filter((event) => event.occurredAtMs >= nowMs - durationMs && event.occurredAtMs <= nowMs).map((event) => event.sessionID)).size;
}
