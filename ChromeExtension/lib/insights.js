import { playbackStreamKey } from "./validation.js";
import { isUnidentifiedYouTubeURL, youtubeVideoIdentity } from "./auto-analysis.js";

const PLAYING_STATES = new Set(["playing", "heartbeat", "rate_changed"]);
const INTENTIONAL_START_SECONDS = 3;
const REPLACEMENT_DEDUPE_MS = 30_000;
const SHORT_CHURN_DEDUPE_MS = 3_000;

function unionSeconds(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let totalMs = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) current = [...interval];
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { totalMs += current[1] - current[0]; current = [...interval]; }
  }
  if (current) totalMs += current[1] - current[0];
  return totalMs / 1000;
}

function clip(start, end, window) {
  const clipped = [Math.max(start, window.startMs), Math.min(end, window.endMs)];
  return clipped[1] > clipped[0] ? clipped : null;
}

function videoIdentity(event) {
  const youtube = youtubeVideoIdentity(event.url);
  if (youtube) return youtube.videoKey;
  // Generic feed URLs often identify the page rather than the media item.
  // Preserve distinct validated sessions instead of inventing equivalence.
  return `session:${event.sessionID}`;
}

function isYouTubeShortURL(url) {
  return /^https:\/\/(?:[^/]+\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]{1,64}(?:[/?]|$)/.test(String(url));
}

function titleQuality(value) {
  const title = String(value || "").trim();
  if (!title || /^(?:untitled(?: video)?|video|youtube|youtube shorts?|netflix)$/i.test(title)) return 0;
  return 1 + Math.min(title.length, 300) / 1000;
}

function preferredTitle(events) {
  return events.map((event) => event.mediaTitle).reduce((best, candidate) => titleQuality(candidate) > titleQuality(best) ? candidate : best, events[0]?.mediaTitle || "Untitled video");
}

export function dayWindow(anchorMs = Date.now(), offsetMinutes = null) {
  if (offsetMinutes === null) {
    const start = new Date(anchorMs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  const shifted = anchorMs + offsetMinutes * 60_000;
  const startMs = Math.floor(shifted / 86_400_000) * 86_400_000 - offsetMinutes * 60_000;
  return { startMs, endMs: startMs + 86_400_000 };
}

export function weekWindow(anchorMs = Date.now(), offsetMinutes = null, weekStartsOn = 1) {
  if (offsetMinutes === null) {
    const start = new Date(anchorMs);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() - weekStartsOn + 7) % 7));
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  const day = dayWindow(anchorMs, offsetMinutes);
  const weekday = new Date(day.startMs + offsetMinutes * 60_000).getUTCDay();
  const startMs = day.startMs - ((weekday - weekStartsOn + 7) % 7) * 86_400_000;
  return { startMs, endMs: startMs + 7 * 86_400_000 };
}

/**
 * Active wall time is the union across all players/frames. Content time is
 * additive, so simultaneous videos do not hide how much media progressed.
 */
export function summarizeViewing(events, window, options = {}) {
  if (!window || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs <= window.startMs) {
    throw new TypeError("invalid insight window");
  }
  // A YouTube homepage/feed URL cannot identify which autoplay preview the DOM
  // player represents. Keep the privacy-minimal telemetry in storage, but do
  // not turn these commonly automatic previews into user-facing insights.
  const sorted = events.filter((event) => !isUnidentifiedYouTubeURL(event.url))
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID));
  const streams = new Map();
  for (const event of sorted) {
    const key = playbackStreamKey(event);
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(event);
  }

  const overallIntervals = [];
  const siteIntervals = new Map();
  const sessionStats = [];
  const videoGroups = new Map();
  const videoAttributionDeltas = new Map();
  let contentSeconds = 0;
  const addInterval = (site, interval) => {
    overallIntervals.push(interval);
    if (!siteIntervals.has(site)) siteIntervals.set(site, []);
    siteIntervals.get(site).push(interval);
  };
  const addVideoInterval = (videoKey, interval) => {
    for (const [time, delta] of [[interval[0], 1], [interval[1], -1]]) {
      if (!videoAttributionDeltas.has(time)) videoAttributionDeltas.set(time, new Map());
      const deltas = videoAttributionDeltas.get(time);
      deltas.set(videoKey, (deltas.get(videoKey) ?? 0) + delta);
    }
  };

  for (const stream of streams.values()) {
    const firstStreamEvent = stream[0];
    const videoKey = videoIdentity(firstStreamEvent);
    const streamTitle = preferredTitle(stream);
    if (!videoGroups.has(videoKey)) {
      const youtube = youtubeVideoIdentity(firstStreamEvent.url);
      videoGroups.set(videoKey, {
        title: streamTitle,
        url: youtube?.canonicalURL ?? firstStreamEvent.url,
        site: firstStreamEvent.pageSite,
        activeSeconds: 0
      });
    } else if (titleQuality(streamTitle) > titleQuality(videoGroups.get(videoKey).title)) {
      videoGroups.get(videoKey).title = streamTitle;
    }
    let meaningfulSeconds = 0;
    let firstProgressAtMs = null;
    let lastProgressAtMs = null;
    let firstPositionSeconds = null;
    let lastPositionSeconds = null;
    for (let index = 0; index + 1 < stream.length; index += 1) {
      const previous = stream[index];
      const next = stream[index + 1];
      if (!PLAYING_STATES.has(previous.state) || !previous.isVisible || !previous.isTabActive) continue;
      const wallMs = next.occurredAtMs - previous.occurredAtMs;
      const mediaDelta = next.positionSeconds - previous.positionSeconds;
      if (wallMs <= 0 || wallMs > 120_000 || mediaDelta <= 0) continue;
      const interval = clip(previous.occurredAtMs, next.occurredAtMs, window);
      if (!interval) continue;
      addInterval(previous.pageSite, interval);
      addVideoInterval(videoKey, interval);
      const plausibleMedia = Math.min(mediaDelta, wallMs / 1000 * Math.max(previous.playbackRate, 1) * 1.5 + 2);
      const meaningful = Math.min(wallMs / 1000, plausibleMedia / Math.max(previous.playbackRate, 0.25));
      meaningfulSeconds += meaningful;
      if (firstProgressAtMs === null) {
        firstProgressAtMs = previous.occurredAtMs;
        firstPositionSeconds = previous.positionSeconds;
      }
      lastProgressAtMs = next.occurredAtMs;
      lastPositionSeconds = next.positionSeconds;
      contentSeconds += plausibleMedia * ((interval[1] - interval[0]) / wallMs);
    }
    const latest = stream[stream.length - 1];
    const nowMs = options.nowMs;
    const freshnessMs = options.freshnessMs ?? 30_000;
    if (Number.isFinite(nowMs) && PLAYING_STATES.has(latest.state) && latest.isVisible && latest.isTabActive && nowMs >= latest.occurredAtMs && nowMs - latest.occurredAtMs <= freshnessMs) {
      const interval = clip(latest.occurredAtMs, Math.min(nowMs, latest.occurredAtMs + freshnessMs), window);
      if (interval) {
        addInterval(latest.pageSite, interval);
        addVideoInterval(videoKey, interval);
      }
    }
    const first = stream[0];
    sessionStats.push({
      sessionID: first.sessionID,
      videoKey,
      pageSite: first.pageSite,
      url: first.url,
      mediaTitle: first.mediaTitle,
      isYouTubeShort: isYouTubeShortURL(first.url),
      meaningfulSeconds,
      firstProgressAtMs,
      lastProgressAtMs,
      firstPositionSeconds,
      lastPositionSeconds,
      endedAtMs: stream.findLast?.((event) => event.state === "ended")?.occurredAtMs
        ?? [...stream].reverse().find((event) => event.state === "ended")?.occurredAtMs
        ?? null
    });
  }

  // A video start is a session with demonstrated visible playback progress, not
  // a metadata event or a newly-created DOM element. Near-contiguous sessions
  // that resume around the same media position are treated as DOM replacement.
  const intentionalStarts = [];
  const candidates = sessionStats
    .filter((stat) => stat.meaningfulSeconds >= INTENTIONAL_START_SECONDS
      && stat.firstProgressAtMs >= window.startMs && stat.firstProgressAtMs < window.endMs)
    .sort((a, b) => a.firstProgressAtMs - b.firstProgressAtMs || a.sessionID.localeCompare(b.sessionID));
  for (const candidate of candidates) {
    const previous = [...intentionalStarts].reverse().find((start) => start.videoKey === candidate.videoKey);
    const closeInTime = previous && candidate.firstProgressAtMs - previous.lastProgressAtMs <= REPLACEMENT_DEDUPE_MS;
    const progressGapMs = previous ? candidate.firstProgressAtMs - previous.lastProgressAtMs : Infinity;
    // Simultaneous streams of one canonical video are one user-visible start,
    // regardless of whether the site exposes watch, embed, or Shorts players.
    const overlapsProgress = previous && progressGapMs <= 0;
    const positionsMatch = previous
      && Math.abs(candidate.firstPositionSeconds - previous.lastPositionSeconds) <= 12;
    const shortPlayerChurn = previous && previous.isYouTubeShort && candidate.isYouTubeShort
      && progressGapMs >= 0 && progressGapMs <= SHORT_CHURN_DEDUPE_MS && positionsMatch;
    const resumesPosition = candidate.firstPositionSeconds > 1 && positionsMatch;
    if (overlapsProgress || shortPlayerChurn || (closeInTime && resumesPosition)) {
      previous.lastProgressAtMs = Math.max(previous.lastProgressAtMs, candidate.lastProgressAtMs);
      previous.lastPositionSeconds = Math.max(previous.lastPositionSeconds, candidate.lastPositionSeconds);
      previous.endedAtMs = candidate.endedAtMs ?? previous.endedAtMs;
    } else {
      intentionalStarts.push({ ...candidate });
    }
  }
  const siteStartCounts = new Map();
  for (const start of intentionalStarts) siteStartCounts.set(start.pageSite, (siteStartCounts.get(start.pageSite) ?? 0) + 1);
  const completed = intentionalStarts.filter((start) => start.endedAtMs >= window.startMs && start.endedAtMs < window.endMs).length;
  // Split each overlap-safe wall-time segment equally among the unique active
  // video identities. Duplicate streams of one YouTube identity are unioned;
  // the sum of video rows therefore equals overall active wall time.
  const activeVideoCounts = new Map();
  const attributionTimes = [...videoAttributionDeltas.keys()].sort((a, b) => a - b);
  for (let index = 0; index + 1 < attributionTimes.length; index += 1) {
    const time = attributionTimes[index];
    for (const [videoKey, delta] of videoAttributionDeltas.get(time)) {
      const count = (activeVideoCounts.get(videoKey) ?? 0) + delta;
      if (count > 0) activeVideoCounts.set(videoKey, count);
      else activeVideoCounts.delete(videoKey);
    }
    const nextTime = attributionTimes[index + 1];
    if (!activeVideoCounts.size || nextTime <= time) continue;
    const shareSeconds = (nextTime - time) / 1000 / activeVideoCounts.size;
    for (const videoKey of activeVideoCounts.keys()) videoGroups.get(videoKey).activeSeconds += shareSeconds;
  }
  const videos = [...videoGroups.values()]
    .filter((video) => video.activeSeconds > 0)
    .sort((a, b) => b.activeSeconds - a.activeSeconds || a.title.localeCompare(b.title) || a.url.localeCompare(b.url));

  const sites = [...siteIntervals.entries()].map(([site, intervals]) => ({
    site,
    activeSeconds: unionSeconds(intervals),
    videosStarted: siteStartCounts.get(site) ?? 0
  })).sort((a, b) => b.activeSeconds - a.activeSeconds || a.site.localeCompare(b.site));

  return Object.freeze({
    window: Object.freeze({ ...window }),
    activeSeconds: unionSeconds(overallIntervals),
    contentSeconds,
    videosStarted: intentionalStarts.length,
    videosCompleted: completed,
    sites: Object.freeze(sites.map(Object.freeze)),
    videos: Object.freeze(videos.map(Object.freeze))
  });
}

export function activeSessionSeconds(events, nowMs, freshnessMs = 30_000) {
  const active = events.filter((event) => event.occurredAtMs <= nowMs).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  const latest = active[active.length - 1];
  if (!latest || !PLAYING_STATES.has(latest.state) || !latest.isVisible || !latest.isTabActive || nowMs - latest.occurredAtMs > freshnessMs) return null;
  const same = active.filter((event) => playbackStreamKey(event) === playbackStreamKey(latest));
  let total = Math.min(freshnessMs, Math.max(0, nowMs - latest.occurredAtMs)) / 1000;
  for (let index = same.length - 2; index >= 0; index -= 1) {
    const previous = same[index];
    const next = same[index + 1];
    const wall = next.occurredAtMs - previous.occurredAtMs;
    const media = next.positionSeconds - previous.positionSeconds;
    if (!PLAYING_STATES.has(previous.state) || !previous.isVisible || !previous.isTabActive || wall <= 0 || wall > 120_000 || media <= 0) break;
    total += Math.min(wall / 1000, media / Math.max(previous.playbackRate, 0.25));
  }
  return total;
}
