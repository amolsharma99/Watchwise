import { FACT_CHECK_CAVEAT, validateAnalysisResult } from "./analysis.js";

export const GEMINI_MODEL = "gemini-3.8-flash";

export const INTERACTION_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "keyPoints", "skipSegments", "verdict", "confidence", "evidence", "caveat", "lowInformationSignal"],
  properties: {
    summary: { type: "string" },
    keyPoints: { type: "array", items: { type: "object", additionalProperties: false, required: ["seconds", "text"], properties: { seconds: { type: "number", minimum: 0 }, text: { type: "string" } } } },
    skipSegments: { type: "array", items: { type: "object", additionalProperties: false, required: ["startSeconds", "endSeconds", "reason"], properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 }, reason: { type: "string" } } } },
    verdict: { type: "string", enum: ["worthWatching", "skim", "readSummary", "probablySkip", "uncertain"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    caveat: { type: "string" },
    lowInformationSignal: { type: "boolean" }
  }
});

export function analysisPrompt(jobID) {
  return `Return only the requested JSON object for job ${jobID}. Summarise this video and assess information value without claiming factual verification. Keep the summary and all strings concise. Return at most 8 key points, at most 6 skip segments, and at most 8 evidence signals. Identify repetition, title/content mismatch, or unsupported claims only as cautious signals. The caveat must explicitly say this is not an external fact-check.`;
}

export function buildInteractionRequest(job, { background = true } = {}) {
  return {
    model: GEMINI_MODEL,
    background,
    store: true,
    input: [
      { type: "text", text: analysisPrompt(job.jobID) },
      { type: "video", uri: job.url }
    ],
    response_format: { type: "text", mime_type: "application/json", schema: INTERACTION_RESPONSE_SCHEMA }
  };
}

export function unwrapInteraction(data) {
  if (data?.interaction && typeof data.interaction === "object") return data.interaction;
  return data && typeof data === "object" ? data : null;
}

export function interactionID(data) {
  const interaction = unwrapInteraction(data);
  const raw = typeof interaction?.id === "string" ? interaction.id : typeof interaction?.name === "string" ? interaction.name.split("/").at(-1) : null;
  return raw && /^[A-Za-z0-9_-]{1,200}$/.test(raw) ? raw : null;
}

export function modelOutputText(data) {
  const interaction = unwrapInteraction(data);
  if (!interaction) return null;
  if (typeof interaction.output_text === "string" && interaction.output_text.trim()) return interaction.output_text;
  if (!Array.isArray(interaction.steps)) return null;
  for (const step of [...interaction.steps].reverse()) {
    if (!step || step.type !== "model_output") continue;
    if (typeof step.output_text === "string" && step.output_text.trim()) return step.output_text;
    if (!Array.isArray(step.content)) continue;
    const texts = step.content.filter((item) => item && typeof item.text === "string" && item.text.trim()).map((item) => item.text);
    if (texts.length) return texts.join("\n");
  }
  return null;
}

export function interactionDisposition(data) {
  const status = String(unwrapInteraction(data)?.status || "").toLowerCase();
  if (["queued", "in_progress"].includes(status)) return "pending";
  if (status === "completed") return "completed";
  return "failed";
}

function interactionErrorText(data) {
  const interaction = unwrapInteraction(data);
  if (!interaction) return "";
  const errors = [interaction.error, ...(Array.isArray(interaction.errors) ? interaction.errors : [])];
  return errors.flatMap((error) => {
    if (typeof error === "string") return [error];
    if (!error || typeof error !== "object") return [];
    return [error.code, error.status, error.message].filter((value) => typeof value === "string");
  }).join(" ").slice(0, 64_000).toLowerCase();
}

export function classifyInteractionFailure(data) {
  const text = interactionErrorText(data);
  if (!text) return "provider_failed";
  if (text.includes("background") && (text.includes("does not support") || text.includes("not support") || text.includes("unsupported"))) return "provider_background_unsupported";
  if (text.includes("model") && (text.includes("not found") || text.includes("unsupported") || text.includes("not supported"))) return "provider_model_unsupported";
  if ((text.includes("youtube") || text.includes("video")) && (text.includes("unavailable") || text.includes("private") || text.includes("unlisted") || text.includes("not found") || text.includes("restricted") || text.includes("permission denied"))) return "provider_video_unavailable";
  if (["unauthenticated", "authentication", "unauthorized", "permission_denied", "permission denied", "forbidden", "api key"].some((term) => text.includes(term))) return "provider_auth";
  if (["resource_exhausted", "resource exhausted", "quota", "billing", "rate limit"].some((term) => text.includes(term))) return "provider_quota";
  if (["deadline_exceeded", "deadline exceeded", "timeout", "timed out"].some((term) => text.includes(term))) return "provider_timeout";
  if (["unavailable", "service unavailable", "internal"].some((term) => text.includes(term))) return "provider_service_error";
  if (["invalid_argument", "invalid argument", "invalid request", "bad request", "failed_precondition", "failed precondition", "not_found", "not found"].some((term) => text.includes(term))) return "provider_invalid_request";
  return "provider_failed";
}

export function analysisResultFromInteraction(data, jobID, completedAtMs = Date.now()) {
  const output = modelOutputText(data);
  if (!output) return null;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ProviderProtocolError("provider_response");
  let parsed;
  try { parsed = JSON.parse(output.slice(start, end + 1)); }
  catch { throw new ProviderProtocolError("provider_response"); }
  return validateAnalysisResult({
    schemaVersion: 1,
    jobID,
    summary: parsed.summary,
    keyPoints: parsed.keyPoints,
    skipSegments: parsed.skipSegments,
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    evidence: parsed.evidence,
    caveat: typeof parsed.caveat === "string" && parsed.caveat.toLowerCase().includes("not an external fact-check") ? parsed.caveat : FACT_CHECK_CAVEAT,
    completedAtMs,
    lowInformationSignal: parsed.lowInformationSignal === true
  }, jobID);
}

export class ProviderProtocolError extends Error {
  constructor(code) { super(code); this.name = "ProviderProtocolError"; this.code = code; }
}

function safeErrorText(body) {
  if (typeof body === "string") return body.slice(0, 64_000).toLowerCase();
  try { return JSON.stringify(body).slice(0, 64_000).toLowerCase(); }
  catch { return ""; }
}

export function classifyHTTPFailure(status, body = "") {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 429 || status === 402) return "provider_quota";
  if (status === 408 || status === 504) return "provider_timeout";
  const text = safeErrorText(body);
  if (status === 400) {
    if (text.includes("api_key_invalid") || text.includes("api key not valid") || text.includes("invalid api key")) return "provider_auth";
    if (text.includes("background") && (text.includes("does not support") || text.includes("not support") || text.includes("unsupported"))) return "provider_background_unsupported";
    if (text.includes("model") && (text.includes("not found") || text.includes("unsupported") || text.includes("not supported"))) return "provider_model_unsupported";
    if ((text.includes("youtube") || text.includes("video")) && (text.includes("unavailable") || text.includes("private") || text.includes("unlisted") || text.includes("not found") || text.includes("restricted"))) return "provider_video_unavailable";
    return "provider_invalid_request";
  }
  if (status === 404 && text.includes("model")) return "provider_model_unsupported";
  if (status === 404 && (text.includes("youtube") || text.includes("video"))) return "provider_video_unavailable";
  if (status === 404) return "provider_invalid_request";
  if (status >= 500) return "provider_service_error";
  return "provider_response";
}

export function classifyNetworkFailure(error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (name.includes("timeout") || name === "aborterror" || message.includes("timeout")) return "provider_timeout";
  return "provider_network";
}

export async function createWithBackgroundFallback(send) {
  try { return await send(true); }
  catch (error) {
    if (error?.code !== "provider_background_unsupported") throw error;
    return send(false);
  }
}

export async function createInteraction(sendRequest, job) {
  return createWithBackgroundFallback(async (background) => {
    const data = await sendRequest(buildInteractionRequest(job, { background }));
    if (background && interactionDisposition(data) === "failed" && classifyInteractionFailure(data) === "provider_background_unsupported") {
      throw new ProviderProtocolError("provider_background_unsupported");
    }
    return data;
  });
}
