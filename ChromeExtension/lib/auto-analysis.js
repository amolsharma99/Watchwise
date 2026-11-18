import { isExcludedSite, normalizeSettings } from "./settings.js";
import { youtubeVideoIdentity } from "./youtube.js";
export { isUnidentifiedYouTubeURL, youtubeVideoIdentity } from "./youtube.js";

export const AUTOMATIC_ANALYSIS_MIN_ACTIVE_SECONDS = 3;

export function automaticAnalysisEligibility({ event, settings: rawSettings, apiKeyConfigured, existingJobs = [], activeWatchedSeconds = 0, nowMs = Date.now() }) {
  const settings = normalizeSettings(rawSettings);
  if (!settings.trackingEnabled) return Object.freeze({ eligible: false, reason: "tracking_off" });
  if (!settings.aiEnabled) return Object.freeze({ eligible: false, reason: "ai_consent_off" });
  if (!settings.autoAnalysisEnabled) return Object.freeze({ eligible: false, reason: "automatic_off" });
  if (!apiKeyConfigured) return Object.freeze({ eligible: false, reason: "key_missing" });
  if (settings.movieModeUntilMs && settings.movieModeUntilMs > nowMs) return Object.freeze({ eligible: false, reason: "movie_mode" });
  if (!event || !["playing", "heartbeat"].includes(event.state) || event.isVisible !== true || event.isTabActive !== true) return Object.freeze({ eligible: false, reason: "inactive_playback" });
  if (!Number.isFinite(activeWatchedSeconds) || activeWatchedSeconds < AUTOMATIC_ANALYSIS_MIN_ACTIVE_SECONDS) return Object.freeze({ eligible: false, reason: "insufficient_progress" });
  if (isExcludedSite(event.frameSite, settings) || isExcludedSite(event.pageSite, settings)) return Object.freeze({ eligible: false, reason: "site_excluded" });
  const identity = youtubeVideoIdentity(event.url);
  if (!identity) return Object.freeze({ eligible: false, reason: "not_public_youtube" });
  const duplicate = existingJobs.some((job) => youtubeVideoIdentity(job.url)?.videoKey === identity.videoKey);
  if (duplicate) return Object.freeze({ eligible: false, reason: "already_requested", ...identity });
  return Object.freeze({ eligible: true, reason: null, ...identity });
}

export function automaticSubmissionEligibility({ job, settings: rawSettings, apiKeyConfigured, source = null, nowMs = Date.now() }) {
  const settings = normalizeSettings(rawSettings);
  if (!job || (job.origin ?? "manual") !== "automatic") return Object.freeze({ eligible: false, reason: "not_automatic" });
  if (!settings.trackingEnabled) return Object.freeze({ eligible: false, reason: "tracking_off" });
  if (!settings.aiEnabled) return Object.freeze({ eligible: false, reason: "ai_consent_off" });
  if (!settings.autoAnalysisEnabled) return Object.freeze({ eligible: false, reason: "automatic_off" });
  if (!apiKeyConfigured) return Object.freeze({ eligible: false, reason: "key_missing" });
  if (settings.movieModeUntilMs && settings.movieModeUntilMs > nowMs) return Object.freeze({ eligible: false, reason: "movie_mode" });
  const identity = youtubeVideoIdentity(job.url);
  if (!identity) return Object.freeze({ eligible: false, reason: "not_public_youtube" });
  const sites = [source?.frameSite, source?.pageSite, "www.youtube.com"].filter(Boolean);
  if (sites.some((site) => isExcludedSite(site, settings))) return Object.freeze({ eligible: false, reason: "site_excluded" });
  return Object.freeze({ eligible: true, reason: null, ...identity });
}
