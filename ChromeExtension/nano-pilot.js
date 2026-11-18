const $ = (selector) => document.querySelector(selector);
const summarizerOptions = { type: "key-points", format: "plain-text", length: "medium", expectedInputLanguages: ["en"], outputLanguage: "en" };
const promptOptions = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const source = await fetch(chrome.runtime.getURL("nano-sample.txt")).then((response) => {
  if (!response.ok) throw new Error("Sample transcript missing");
  return response.text();
});

async function checkAvailability(apiName, options, statusSelector, buttonSelector) {
  const status = $(statusSelector);
  if (!(apiName in self)) {
    status.textContent = `${apiName} is unavailable in this extension.`;
    return;
  }
  try {
    const availability = await self[apiName].availability(options);
    status.textContent = `${apiName}: ${availability}`;
    $(buttonSelector).disabled = availability === "unavailable";
  } catch (error) {
    status.textContent = `${apiName} check failed: ${error.name}: ${error.message}`;
  }
}

await Promise.all([
  checkAvailability("Summarizer", summarizerOptions, "#summarizerStatus", "#summarize"),
  checkAvailability("LanguageModel", promptOptions, "#promptStatus", "#assess")
]);

$("#summarize").addEventListener("click", async () => {
  const button = $("#summarize");
  const status = $("#summarizerStatus");
  button.disabled = true;
  $("#summaryOutput").textContent = "";
  let summarizer;
  try {
    status.textContent = "Preparing the local summarizer…";
    summarizer = await Summarizer.create({
      ...summarizerOptions,
      monitor(m) { m.addEventListener("downloadprogress", (event) => { status.textContent = `Downloading local model: ${Math.round(event.loaded * 100)}%`; }); }
    });
    status.textContent = "Summarising locally…";
    $("#summaryOutput").textContent = await summarizer.summarize(source);
    status.textContent = "Local summary complete.";
  } catch (error) {
    status.textContent = `Local summary failed: ${error.name}: ${error.message}`;
  } finally {
    summarizer?.destroy();
    button.disabled = false;
  }
});

$("#assess").addEventListener("click", async () => {
  const button = $("#assess");
  const status = $("#promptStatus");
  button.disabled = true;
  $("#assessmentOutput").textContent = "";
  let session;
  try {
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
    status.textContent = `Local assessment failed: ${error.name}: ${error.message}`;
  } finally {
    session?.destroy();
    button.disabled = false;
  }
});
