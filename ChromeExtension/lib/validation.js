const EVENT_KEYS = new Set([
  "schemaVersion", "eventID", "sessionID", "playerID", "tabID", "frameID",
  "frameSite", "pageSite", "url", "mediaTitle", "durationSeconds",
  "positionSeconds", "playbackRate", "state", "occurredAtMs", "isVisible",
  "isTabActive"
]);

const STATES = new Set(["playing", "paused", "seeking", "ended", "heartbeat", "rate_changed"]);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

export const URL_MINIMIZATION_POLICY = "Canonical URLs discard every query parameter except a valid YouTube v video ID; credentials and fragments are always rejected or removed.";

export class ValidationError extends Error {
  constructor(field, message = "invalid") {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

function finiteNumber(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ValidationError(field);
  }
  return value;
}

export function normalizeHostname(input) {
  if (typeof input !== "string") throw new ValidationError("site");
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !host.includes(".") || host.includes(":") || host.includes("@")) {
    throw new ValidationError("site");
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith(".") || host.endsWith(".")) {
    throw new ValidationError("site");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ValidationError("site", "local hosts are not accepted");
  }
  const parts = host.split(".");
  const numbers = parts.map((part) => /^\d+$/.test(part) ? Number(part) : NaN);
  if (numbers.every(Number.isFinite) && numbers.length === 4) {
    if (numbers.some((part) => part < 0 || part > 255)) throw new ValidationError("site");
    const [a, b] = numbers;
    if ([0, 10, 127].includes(a) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new ValidationError("site", "private hosts are not accepted");
    }
  }
  return host;
}

export function siteMatches(host, configuredSite) {
  const normalizedHost = normalizeHostname(host);
  const normalizedSite = normalizeHostname(configuredSite);
  return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
}

export function canonicalizePublicURL(input, allowedSites = []) {
  if (typeof input !== "string" || input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new ValidationError("url");
  }
  const match = /^https:\/\/([^/?#]+)([^#]*)?(?:#.*)?$/i.exec(input.trim());
  if (!match || match[1].includes("@")) throw new ValidationError("url", "public HTTPS required");
  const authority = match[1].toLowerCase();
  const authorityMatch = /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!authorityMatch || (authorityMatch[2] && authorityMatch[2] !== "443")) throw new ValidationError("url");
  const host = normalizeHostname(authorityMatch[1]);
  if (allowedSites.length && !allowedSites.some((site) => siteMatches(host, site))) {
    throw new ValidationError("url", "host does not match frame or page site");
  }
  let suffix = match[2] || "/";
  if (!suffix.startsWith("/")) suffix = `/${suffix}`;
  const queryIndex = suffix.indexOf("?");
  const path = queryIndex >= 0 ? suffix.slice(0, queryIndex) : suffix;
  let retainedQuery = "";
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const rawQuery = queryIndex >= 0 ? suffix.slice(queryIndex + 1) : "";
    for (const pair of rawQuery.split("&")) {
      const separator = pair.indexOf("=");
      if (separator < 0) continue;
      let key;
      let value;
      try {
        key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, " "));
        value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "));
      } catch { continue; }
      if (key === "v" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        retainedQuery = `?v=${encodeURIComponent(value)}`;
        break;
      }
    }
  }
  suffix = `${path || "/"}${retainedQuery}`;
  return `https://${host}${authorityMatch[2] ? ":443" : ""}${suffix}`;
}

function cleanText(value, field, maximum) {
  if (typeof value !== "string") throw new ValidationError(field);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > maximum) throw new ValidationError(field);
  return clean;
}

/** Strictly validates the only playback payload that may enter persistence. */
export function validatePlaybackEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("event");
  const unknown = Object.keys(input).filter((key) => !EVENT_KEYS.has(key));
  if (unknown.length) throw new ValidationError("event", `unknown fields: ${unknown.sort().join(",")}`);
  if (input.schemaVersion !== 1) throw new ValidationError("schemaVersion");
  for (const field of ["eventID", "sessionID", "playerID"]) {
    if (typeof input[field] !== "string" || !IDENTIFIER.test(input[field])) throw new ValidationError(field);
  }
  const tabID = finiteNumber(input.tabID, "tabID", 0, 2 ** 31 - 1);
  const frameID = finiteNumber(input.frameID, "frameID", 0, 2 ** 31 - 1);
  if (!Number.isInteger(tabID) || !Number.isInteger(frameID)) throw new ValidationError("frame");
  const frameSite = normalizeHostname(input.frameSite);
  const pageSite = normalizeHostname(input.pageSite);
  const url = canonicalizePublicURL(input.url, [frameSite, pageSite]);
  const durationSeconds = finiteNumber(input.durationSeconds, "durationSeconds", 0.1, 24 * 60 * 60);
  const positionSeconds = finiteNumber(input.positionSeconds, "positionSeconds", 0, durationSeconds + 5);
  const playbackRate = finiteNumber(input.playbackRate, "playbackRate", 0.25, 4);
  if (!STATES.has(input.state)) throw new ValidationError("state");
  const occurredAtMs = finiteNumber(input.occurredAtMs, "occurredAtMs", 1, 8.64e15);
  if (typeof input.isVisible !== "boolean" || typeof input.isTabActive !== "boolean") throw new ValidationError("visibility");
  return Object.freeze({
    schemaVersion: 1,
    eventID: input.eventID,
    sessionID: input.sessionID,
    playerID: input.playerID,
    tabID,
    frameID,
    frameSite,
    pageSite,
    url,
    mediaTitle: cleanText(input.mediaTitle, "mediaTitle", 300),
    durationSeconds,
    positionSeconds: Math.min(positionSeconds, durationSeconds),
    playbackRate,
    state: input.state,
    occurredAtMs,
    isVisible: input.isVisible,
    isTabActive: input.isTabActive
  });
}

export function playbackStreamKey(event) {
  return `${event.tabID}:${event.frameID}:${event.playerID}:${event.sessionID}`;
}
