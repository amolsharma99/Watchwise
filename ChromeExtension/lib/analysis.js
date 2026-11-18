import { canonicalizePublicURL, ValidationError } from "./validation.js";

export const ANALYSIS_STATUSES = Object.freeze([
  "queued", "submitting", "remote", "running", "succeeded", "failed", "cancelled"
]);
export const TERMINAL_ANALYSIS_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const VERDICTS = Object.freeze(["worthWatching", "skim", "readSummary", "probablySkip", "uncertain"]);
export const FACT_CHECK_CAVEAT = "This content-quality assessment is not an external fact-check.";

const TRANSITIONS = Object.freeze({
  queued: new Set(["submitting", "cancelled", "failed"]),
  // Self-transitions make restart/retry actions idempotent. They update the
  // persisted attempt/timing fields without inventing a new job identity.
  submitting: new Set(["submitting", "remote", "running", "failed", "cancelled"]),
  remote: new Set(["remote", "running", "succeeded", "failed", "cancelled"]),
  running: new Set(["running", "remote", "succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set()
});

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(field);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ValidationError(field, `unknown fields: ${unknown.sort().join(",")}`);
}

function text(value, field, maximum) {
  if (typeof value !== "string") throw new ValidationError(field);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > maximum) throw new ValidationError(field);
  return clean;
}

export function createAnalysisJob({ jobID, url, mediaTitle, origin = "manual", nowMs = Date.now() }) {
  if (typeof jobID !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(jobID)) throw new ValidationError("jobID");
  if (!["manual", "automatic"].includes(origin)) throw new ValidationError("origin");
  return Object.freeze({
    schemaVersion: 1,
    jobID,
    url: canonicalizePublicURL(url),
    mediaTitle: text(mediaTitle, "mediaTitle", 300),
    origin,
    status: "queued",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    providerJobID: null,
    nextPollAtMs: null,
    attempt: 0,
    errorCode: null
  });
}

export function transitionAnalysisJob(job, nextStatus, patch = {}, nowMs = Date.now()) {
  validateAnalysisJob(job);
  if (!ANALYSIS_STATUSES.includes(nextStatus) || !TRANSITIONS[job.status].has(nextStatus)) {
    throw new ValidationError("status", `transition ${job.status} -> ${nextStatus} is not allowed`);
  }
  const allowedPatch = new Set(["providerJobID", "nextPollAtMs", "attempt", "errorCode"]);
  const unknown = Object.keys(patch).filter((key) => !allowedPatch.has(key));
  if (unknown.length) throw new ValidationError("jobPatch");
  const updated = {
    ...job,
    origin: job.origin ?? "manual",
    ...patch,
    status: nextStatus,
    updatedAtMs: Math.max(nowMs, job.updatedAtMs + 1)
  };
  if (typeof updated.attempt !== "number" || !Number.isInteger(updated.attempt) || updated.attempt < 0 || updated.attempt > 100) throw new ValidationError("attempt");
  if (updated.providerJobID !== null && (typeof updated.providerJobID !== "string" || updated.providerJobID.length > 256)) throw new ValidationError("providerJobID");
  if (updated.errorCode !== null && (typeof updated.errorCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(updated.errorCode))) throw new ValidationError("errorCode");
  validateAnalysisJob(updated);
  return Object.freeze(updated);
}

/** Prevents an older async UI response from replacing a newer job transition. */
export function shouldAcceptAnalysisJobUpdate(current, candidate) {
  if (!candidate) return true;
  if (!current || current.jobID !== candidate.jobID) return true;
  return Number(candidate.updatedAtMs) >= Number(current.updatedAtMs);
}

export function validateAnalysisJob(job) {
  exactKeys(job, ["schemaVersion", "jobID", "url", "mediaTitle", "origin", "status", "createdAtMs", "updatedAtMs", "providerJobID", "nextPollAtMs", "attempt", "errorCode"], "job");
  if (job.schemaVersion !== 1 || typeof job.jobID !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(job.jobID) || !ANALYSIS_STATUSES.includes(job.status)) throw new ValidationError("job");
  canonicalizePublicURL(job.url);
  text(job.mediaTitle, "mediaTitle", 300);
  if (job.origin !== undefined && !["manual", "automatic"].includes(job.origin)) throw new ValidationError("origin");
  for (const field of ["createdAtMs", "updatedAtMs"]) if (!Number.isFinite(job[field])) throw new ValidationError(field);
  if (job.updatedAtMs < job.createdAtMs) throw new ValidationError("updatedAtMs");
  if (job.nextPollAtMs !== null && !Number.isFinite(job.nextPollAtMs)) throw new ValidationError("nextPollAtMs");
  if (!Number.isInteger(job.attempt) || job.attempt < 0 || job.attempt > 100) throw new ValidationError("attempt");
  if (job.providerJobID !== null && (typeof job.providerJobID !== "string" || job.providerJobID.length > 256)) throw new ValidationError("providerJobID");
  if (job.errorCode !== null && (typeof job.errorCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(job.errorCode))) throw new ValidationError("errorCode");
  return job;
}

export function restartAction(job, nowMs = Date.now()) {
  validateAnalysisJob(job);
  switch (job.status) {
    case "queued": return "submit";
    case "submitting": return job.providerJobID ? "poll" : "submit";
    case "remote":
    case "running": return !job.nextPollAtMs || job.nextPollAtMs <= nowMs ? "poll" : "wait";
    default: return "none";
  }
}

export function validateAnalysisResult(input, jobID = null) {
  exactKeys(input, ["schemaVersion", "jobID", "summary", "keyPoints", "skipSegments", "verdict", "confidence", "evidence", "caveat", "completedAtMs", "lowInformationSignal"], "analysisResult");
  if (input.schemaVersion !== 1) throw new ValidationError("schemaVersion");
  const resultJobID = jobID ?? input.jobID;
  if (typeof resultJobID !== "string" || input.jobID !== resultJobID) throw new ValidationError("jobID");
  const summary = text(input.summary, "summary", 1200);
  if (!VERDICTS.includes(input.verdict)) throw new ValidationError("verdict");
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new ValidationError("confidence");
  if (typeof input.caveat !== "string" || !input.caveat.toLowerCase().includes("not an external fact-check")) throw new ValidationError("caveat", "explicit non-fact-check caveat required");
  if (typeof input.lowInformationSignal !== "boolean") throw new ValidationError("lowInformationSignal");
  if (!Number.isFinite(input.completedAtMs)) throw new ValidationError("completedAtMs");
  if (!Array.isArray(input.keyPoints) || input.keyPoints.length > 8) throw new ValidationError("keyPoints");
  const keyPoints = input.keyPoints.map((point, index) => {
    exactKeys(point, ["seconds", "text"], `keyPoints.${index}`);
    if (!Number.isFinite(point.seconds) || point.seconds < 0 || point.seconds > 24 * 60 * 60) throw new ValidationError(`keyPoints.${index}.seconds`);
    return Object.freeze({ seconds: point.seconds, text: text(point.text, `keyPoints.${index}.text`, 500) });
  });
  if (!Array.isArray(input.skipSegments) || input.skipSegments.length > 6) throw new ValidationError("skipSegments");
  const skipSegments = input.skipSegments.map((segment, index) => {
    exactKeys(segment, ["startSeconds", "endSeconds", "reason"], `skipSegments.${index}`);
    if (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) || segment.startSeconds < 0 || segment.endSeconds <= segment.startSeconds || segment.endSeconds > 24 * 60 * 60) throw new ValidationError(`skipSegments.${index}`);
    return Object.freeze({ startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, reason: text(segment.reason, `skipSegments.${index}.reason`, 300) });
  });
  if (!Array.isArray(input.evidence) || input.evidence.length > 8) throw new ValidationError("evidence");
  const evidence = input.evidence.map((item, index) => text(item, `evidence.${index}`, 500));
  return Object.freeze({
    schemaVersion: 1,
    jobID: resultJobID,
    summary,
    keyPoints: Object.freeze(keyPoints),
    skipSegments: Object.freeze(skipSegments),
    verdict: input.verdict,
    confidence: input.confidence,
    evidence: Object.freeze(evidence),
    caveat: text(input.caveat, "caveat", 500),
    completedAtMs: input.completedAtMs,
    lowInformationSignal: input.lowInformationSignal
  });
}

export function aiEvidenceFromResult(result, positionSeconds) {
  const validated = validateAnalysisResult(result);
  const nextSkip = validated.skipSegments.find((segment) => segment.endSeconds > positionSeconds + 5);
  return Object.freeze({
    source: "validated_analysis",
    confidence: validated.confidence,
    lowInformationSignal: validated.lowInformationSignal,
    skipTimestampSeconds: nextSkip?.endSeconds ?? null,
    evidenceText: validated.evidence[0] ?? validated.summary
  });
}
