import { canonicalizePublicURL } from "./validation.js";
import { isExcludedSite, normalizeSettings } from "./settings.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const AUTOMATIC_ANALYSIS_MIN_ACTIVE_SECONDS = 3;

/** Returns a stable identity shared by watch, embed, shorts, live, and youtu.be URLs. */
export function youtubeVideoIdentity(input) {
  let canonical;
  try { canonical = canonicalizePublicURL(input); }
  catch { return null; }
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(canonical);
  if (!match) return null;
  const host = match[1].replace(/:443$/, "").toLowerCase();
  const path = match[2] || "/";
  let videoID = null;
  if (host === "youtu.be") {
    videoID = path.split("/").filter(Boolean)[0] || null;
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (path === "/watch") {
      for (const pair of (match[3] || "").split("&")) {
        const [key, rawValue = ""] = pair.split("=", 2);
        if (key === "v") {
          try { videoID = decodeURIComponent(rawValue); } catch { videoID = null; }
          break;
        }
      }
    } else {
      const parts = path.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) videoID = parts[1] || null;
    }
  }
  if (!VIDEO_ID.test(videoID || "")) return null;
  return Object.freeze({
    videoID,
    videoKey: `youtube:${videoID}`,
    canonicalURL: `https://www.youtube.com/watch?v=${encodeURIComponent(videoID)}`
  });
}

/** True only for exact YouTube/youtu.be pages that lack a stable video ID. */
export function isUnidentifiedYouTubeURL(input) {
  let canonical;
  try { canonical = canonicalizePublicURL(input); }
  catch { return false; }
  if (youtubeVideoIdentity(canonical)) return false;
  const host = /^https:\/\/([^/?#]+)/.exec(canonical)?.[1]?.replace(/:443$/, "").toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host?.endsWith(".youtube.com");
}

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
