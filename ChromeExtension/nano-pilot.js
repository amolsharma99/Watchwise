const $ = (selector) => document.querySelector(selector);
const summarizerOptions = { type: "key-points", format: "plain-text", length: "medium", expectedInputLanguages: ["en"], outputLanguage: "en" };
const promptOptions = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
let transcriptPromise = null;
$("#summarize").disabled = true;
$("#assess").disabled = true;

function loadTranscript() {
  transcriptPromise ||= fetch(chrome.runtime.getURL("nano-sample.txt")).then((response) => {
    if (!response.ok) throw new Error("Sample transcript missing");
    return response.text();
  });
  return transcriptPromise;
}

const runnableAvailability = new Set(["available", "downloadable", "downloading"]);
let summarizerReady = false;
let promptReady = false;

function localAIUnavailable(status) {
  status.textContent = "Chrome local AI is unavailable on this device/configuration. This local trial is separate from Watchwise tracking and Gemini analysis.";
}

function isCapabilityUnavailable(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return name === "NotAllowedError" || /model (?:capability|adaptation).*(?:not available|unavailable)/.test(message);
}

function setAvailability(status, label, availability) {
  status.textContent = `${label}: ${availability}`;
  return runnableAvailability.has(availability);
}

async function checkSummarizerAvailability() {
  const status = $("#summarizerStatus");
  summarizerReady = false;
  $("#summarize").disabled = true;
  if (!("Summarizer" in self)) { localAIUnavailable(status); return; }
  try {
    summarizerReady = setAvailability(status, "Summarizer", await Summarizer.availability(summarizerOptions));
    $("#summarize").disabled = !summarizerReady;
  } catch (error) {
    if (isCapabilityUnavailable(error)) localAIUnavailable(status);
    else status.textContent = `Summarizer availability check failed (${String(error?.name || "Error")}).`;
  }
}

async function checkPromptAvailability() {
  const status = $("#promptStatus");
  promptReady = false;
  $("#assess").disabled = true;
  if (!("LanguageModel" in self)) { localAIUnavailable(status); return; }
  try {
    const base = await LanguageModel.availability();
    if (!runnableAvailability.has(base)) {
      status.textContent = `Prompt API: base ${base}; configured task not checked`;
      return;
    }
    const configured = await LanguageModel.availability(promptOptions);
    status.textContent = `Prompt API: base ${base}; configured task ${configured}`;
    promptReady = runnableAvailability.has(configured);
    $("#assess").disabled = !promptReady;
  } catch (error) {
    if (isCapabilityUnavailable(error)) localAIUnavailable(status);
    else status.textContent = `Prompt API availability check failed (${String(error?.name || "Error")}).`;
  }
}

$("#checkAvailability").addEventListener("click", async () => {
  const button = $("#checkAvailability");
  button.disabled = true;
  try {
    await Promise.all([checkSummarizerAvailability(), checkPromptAvailability()]);
  } finally {
    button.disabled = false;
  }
});

$("#summarize").addEventListener("click", async () => {
  const button = $("#summarize");
  const status = $("#summarizerStatus");
  button.disabled = true;
  $("#summaryOutput").textContent = "";
  let summarizer;
  try {
    const availability = await Summarizer.availability(summarizerOptions);
    summarizerReady = runnableAvailability.has(availability);
    if (!summarizerReady) { localAIUnavailable(status); return; }
    const source = await loadTranscript();
    status.textContent = "Preparing the local summarizer…";
    summarizer = await Summarizer.create({
      ...summarizerOptions,
      monitor(m) { m.addEventListener("downloadprogress", (event) => { status.textContent = `Downloading local model: ${Math.round(event.loaded * 100)}%`; }); }
    });
    status.textContent = "Summarising locally…";
    $("#summaryOutput").textContent = await summarizer.summarize(source);
    status.textContent = "Local summary complete.";
  } catch (error) {
    if (isCapabilityUnavailable(error)) {
      summarizerReady = false;
      localAIUnavailable(status);
    } else status.textContent = `Local summary could not run (${String(error?.name || "Error")}).`;
  } finally {
    try { summarizer?.destroy(); } catch {}
    button.disabled = !summarizerReady;
  }
});

$("#assess").addEventListener("click", async () => {
  const button = $("#assess");
  const status = $("#promptStatus");
  button.disabled = true;
  $("#assessmentOutput").textContent = "";
  let session;
  try {
    const availability = await LanguageModel.availability(promptOptions);
    promptReady = runnableAvailability.has(availability);
    if (!promptReady) { localAIUnavailable(status); return; }
    const source = await loadTranscript();
    status.textContent = "Preparing the local language model…";
    session = await LanguageModel.create({
      ...promptOptions,
      monitor(m) { m.addEventListener("downloadprogress", (event) => { status.textContent = `Downloading local model: ${Math.round(event.loaded * 100)}%`; }); }
    });
    status.textContent = "Assessing transcript locally…";
    const prompt = `Use only this transcript of a 4-minute video. In under 180 words, give: (1) the main point, (2) three useful details with timestamps from the transcript, (3) a verdict of watch, skim, or skip and one reason. Say when the transcript is too thin to judge. Do not claim you checked facts or visuals.\n\n${source}`;
    $("#assessmentOutput").textContent = await session.prompt(prompt);
    status.textContent = "Local assessment complete.";
  } catch (error) {
    if (isCapabilityUnavailable(error)) {
      promptReady = false;
      localAIUnavailable(status);
    } else status.textContent = `Local assessment could not run (${String(error?.name || "Error")}).`;
  } finally {
    try { session?.destroy(); } catch {}
    button.disabled = !promptReady;
  }
});
