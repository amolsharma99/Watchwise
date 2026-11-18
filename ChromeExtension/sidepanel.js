import { shouldAcceptAnalysisJobUpdate } from "./lib/analysis.js";
import { IndexedDBRepository } from "./lib/storage.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let dashboard = null;
let breakdownRange = "today";
let refreshSequence = 0;
let versionMismatchNotified = false;
let renderedAnalysisJob = null;
const repository = new IndexedDBRepository();

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Watchwise could not complete that action.");
  return response;
}

function notify(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.background = isError ? "#632f3b" : "#252231";
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 4_000);
}

function formatDuration(seconds = 0) {
  if (seconds > 0 && seconds < 60) return "<1m";
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTimestamp(seconds = 0) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function minuteToTime(minute) {
  const safe = Number.isFinite(minute) ? Math.max(0, Math.min(1439, Math.trunc(minute))) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function timeToMinute(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : 0;
}

function setText(selector, value) { $(selector).textContent = String(value); }

function renderSites(sites = []) {
  const container = $("#sites");
  container.replaceChildren();
  if (!sites.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No viewing recorded yet.";
    container.append(empty);
    return;
  }
  const maximum = Math.max(...sites.map((site) => site.activeSeconds), 1);
  for (const site of sites.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "site-row";
    const name = document.createElement("strong");
    name.textContent = site.site;
    const time = document.createElement("span");
    time.textContent = formatDuration(site.activeSeconds);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(3, Math.round(site.activeSeconds / maximum * 100))}%`;
    bar.append(fill);
    row.append(name, time, bar);
    container.append(row);
  }
}

function formatWatchedMinutes(seconds = 0) {
  const minutes = Math.max(0, seconds) / 60;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}

function renderVideoBreakdown() {
  const container = $("#videoBreakdown");
  container.replaceChildren();
  const videos = [...(dashboard?.[breakdownRange]?.videos || [])]
    .sort((a, b) => b.activeSeconds - a.activeSeconds || a.title.localeCompare(b.title));
  if (!videos.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No watched videos yet.";
    container.append(empty);
    return;
  }
  for (const video of videos) {
    const row = document.createElement("div");
    row.className = "video-row";
    const title = document.createElement("strong");
    const fullTitle = String(video.title || "Untitled video").slice(0, 300);
    title.textContent = fullTitle;
    title.title = fullTitle;
    const watched = document.createElement("time");
    watched.textContent = formatWatchedMinutes(video.activeSeconds);
    const meta = document.createElement("div");
    meta.className = "video-meta";
    const site = document.createElement("span");
    site.textContent = String(video.site || "").slice(0, 253);
    meta.append(site);
    try {
      const url = new URL(video.url);
      if (url.protocol === "https:") {
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open video";
        meta.append(link);
      }
    } catch {}
    row.append(title, watched, meta);
    container.append(row);
  }
}

function renderExclusions(sites = []) {
  const container = $("#exclusions");
  container.replaceChildren();
  for (const site of sites) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(site));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${site}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => updateSettings({ excludedSites: sites.filter((item) => item !== site) }));
    chip.append(remove);
    container.append(chip);
  }
}

function makeMoment(point, job) {
  const row = document.createElement("div");
  row.className = "moment";
  const time = document.createElement("button");
  time.className = "timestamp";
  time.type = "button";
  time.textContent = formatTimestamp(point.seconds ?? point.startSeconds);
  time.title = "Jump to this moment when the original player is still open";
  time.addEventListener("click", async () => {
    try {
      await send("SEEK_TIMESTAMP", {
        seconds: point.seconds ?? point.startSeconds,
        tabId: job?.source?.tabId,
        frameId: job?.source?.frameId,
        playerId: job?.source?.playerId
      });
    } catch (error) { notify(error.message, true); }
  });
  const label = document.createElement("span");
  label.textContent = point.text ?? point.reason ?? "Moment";
  row.append(time, label);
  return row;
}

function renderJob(job) {
  if (job && !shouldAcceptAnalysisJobUpdate(renderedAnalysisJob, job)) return;
  renderedAnalysisJob = job || null;
  const status = $("#analysisStatus");
  const resultCard = $("#analysisResult");
  if (!job) {
    status.textContent = "No analysis requested yet.";
    resultCard.hidden = true;
    return;
  }
  const labels = { queued: "Queued securely…", submitting: "Sending the public URL to Gemini…", remote: "Gemini accepted the video; waiting for processing…", running: "Gemini is analysing the video…", failed: "Analysis failed.", succeeded: "Analysis ready." };
  status.textContent = labels[job.status] || "Checking analysis…";
  if (job.status === "failed") {
    status.textContent = job.error || "Analysis failed without exposing request details.";
    resultCard.hidden = true;
    return;
  }
  if (job.status !== "succeeded" || !job.result) {
    resultCard.hidden = true;
    return;
  }
  const result = job.result;
  resultCard.hidden = false;
  setText("#verdict", String(result.verdict || "uncertain").replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase()));
  setText("#confidence", `${Math.round(Math.max(0, Math.min(1, result.confidence || 0)) * 100)}% confidence`);
  setText("#summary", result.summary || "No summary returned.");
  setText("#caveat", result.caveat || "This is a content-quality assessment, not an external fact-check.");
  const keyPoints = $("#keyPoints");
  keyPoints.replaceChildren(...(result.keyPoints || []).map((point) => makeMoment(point, job)));
  const skips = $("#skipSegments");
  skips.replaceChildren(...(result.skipSegments || []).map((segment) => makeMoment(segment, job)));
  const evidence = $("#evidence");
  evidence.replaceChildren(...(result.evidence || []).map((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
}

function render(state) {
  dashboard = state;
  const panelVersion = chrome.runtime.getManifest().version;
  const runtimeVersion = String(state.extensionVersion || panelVersion);
  setText("#buildVersion", `Watch with intent · v${runtimeVersion}`);
  if (!versionMismatchNotified && runtimeVersion !== panelVersion) {
    versionMismatchNotified = true;
    notify("Watchwise was updated. Close and reopen this side panel to use the current build.", true);
  }
  $("#onboarding").hidden = state.onboardingComplete === true;
  $("#app").hidden = state.onboardingComplete !== true;
  const settings = state.settings || {};
  const today = state.today || {};
  const week = state.week || {};
  setText("#todayTime", formatDuration(today.activeSeconds));
  setText("#todayStarted", today.videosStarted || 0);
  setText("#weekTime", formatDuration(week.activeSeconds));
  setText("#weekVideos", `${week.videosStarted || 0} starts`);
  const comparison = state.previousWeekActiveSeconds > 0 ? Math.round(((week.activeSeconds || 0) - state.previousWeekActiveSeconds) / state.previousWeekActiveSeconds * 100) : null;
  $("#weekComparison").hidden = comparison === null;
  if (comparison !== null) setText("#weekComparison", `${comparison >= 0 ? "+" : ""}${comparison}% vs last week`);
  renderSites(today.sites);
  renderVideoBreakdown();
  const pill = $("#trackingPill");
  const connection = state.trackingConnection || { status: "reconnecting", reason: null };
  if (!settings.trackingEnabled) pill.textContent = "Tracking off";
  else if (connection.reason === "excluded") pill.textContent = "Tracking off here · excluded";
  else if (connection.status === "connected") pill.textContent = "Tracker connected";
  else if (connection.status === "reload_required") pill.textContent = "Tracking on · reload video tab";
  else if (connection.status === "not_applicable") pill.textContent = "Tracking on · unavailable here";
  else pill.textContent = "Tracking on · reconnecting";
  pill.classList.toggle("off", !settings.trackingEnabled || connection.status === "not_applicable");
  $("#trackingEnabled").checked = settings.trackingEnabled === true;
  $("#notificationsEnabled").checked = settings.notificationsEnabled === true;
  $("#aiConsent").checked = settings.aiEnabled === true;
  $("#autoAnalysisEnabled").checked = settings.autoAnalysisEnabled !== false;
  $("#quietEnabled").checked = settings.quietHoursEnabled === true;
  $("#quietStart").value = minuteToTime(settings.quietHoursStartMinute);
  $("#quietEnd").value = minuteToTime(settings.quietHoursEndMinute);
  $("#dailyLimit").value = Math.round((settings.dailyLimitSeconds || 3600) / 60);
  setText("#dailyLimitLabel", `${$("#dailyLimit").value} minutes`);
  const movieActive = Number(settings.movieModeUntilMs) > Date.now();
  $("#movieMode").textContent = movieActive ? "End Movie Mode" : "Movie Mode · 2h";
  $("#movieModeQuick").textContent = movieActive ? "End Movie Mode" : "Movie Mode · 2h";
  $("#movieMode").dataset.active = String(movieActive);
  $("#movieModeQuick").dataset.active = String(movieActive);
  const snoozeActive = Number(settings.snoozedUntilMs) > Date.now();
  $("#snooze").textContent = snoozeActive ? "End snooze" : "Snooze · 30m";
  $("#snooze").dataset.active = String(snoozeActive);
  renderExclusions(settings.excludedSites || []);
  setText("#keyStatus", state.apiKeyConfigured ? "Saved for this extension" : "Not saved");
  $("#clearKey").disabled = !state.apiKeyConfigured;
  renderJob(state.activeJob);
  if (state.currentPublicURL && !$("#analysisURL").value) $("#analysisURL").value = state.currentPublicURL;
}

async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const state = (await send("GET_DASHBOARD_STATE")).state;
    if (sequence === refreshSequence) render(state);
  }
  catch (error) { if (sequence === refreshSequence) notify(error.message, true); }
}

function invalidateFullStateRequests() {
  refreshSequence += 1;
}

async function updateSettings(patch) {
  invalidateFullStateRequests();
  try {
    await send("UPDATE_SETTINGS", { patch });
    await refresh();
    return true;
  } catch (error) {
    notify(error.message, true);
    void refresh();
    return false;
  }
}

$$('.tab').forEach((tab) => tab.addEventListener("click", () => {
  $$('.tab').forEach((item) => item.classList.toggle("active", item === tab));
  $$('.panel').forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.panel));
}));
$$('[data-video-range]').forEach((button) => button.addEventListener("click", () => {
  breakdownRange = button.dataset.videoRange === "week" ? "week" : "today";
  $$('[data-video-range]').forEach((item) => item.classList.toggle("active", item === button));
  renderVideoBreakdown();
}));
$("#refresh").addEventListener("click", refresh);
$("#finishOnboarding").addEventListener("click", async () => {
  invalidateFullStateRequests();
  try {
    await send("COMPLETE_ONBOARDING", {
      trackingEnabled: $("#onboardTracking").checked,
      aiEnabled: $("#onboardAI").checked
    });
    await refresh();
  } catch (error) {
    notify(error.message, true);
    void refresh();
  }
});
for (const [selector, key] of [["#trackingEnabled", "trackingEnabled"], ["#notificationsEnabled", "notificationsEnabled"], ["#aiConsent", "aiEnabled"], ["#autoAnalysisEnabled", "autoAnalysisEnabled"], ["#quietEnabled", "quietHoursEnabled"]]) {
  $(selector).addEventListener("change", (event) => updateSettings({ [key]: event.target.checked }));
}
$("#dailyLimit").addEventListener("input", (event) => setText("#dailyLimitLabel", `${event.target.value} minutes`));
$("#dailyLimit").addEventListener("change", (event) => updateSettings({ dailyLimitSeconds: Number(event.target.value) * 60 }));
$("#quietStart").addEventListener("change", (event) => updateSettings({ quietHoursStartMinute: timeToMinute(event.target.value) }));
$("#quietEnd").addEventListener("change", (event) => updateSettings({ quietHoursEndMinute: timeToMinute(event.target.value) }));
$("#movieModeQuick").addEventListener("click", (event) => updateSettings({ movieModeUntilMs: event.currentTarget.dataset.active === "true" ? null : Date.now() + 2 * 60 * 60_000 }));
$("#movieMode").addEventListener("click", (event) => updateSettings({ movieModeUntilMs: event.currentTarget.dataset.active === "true" ? null : Date.now() + 2 * 60 * 60_000 }));
$("#snooze").addEventListener("click", (event) => updateSettings({ snoozedUntilMs: event.currentTarget.dataset.active === "true" ? null : Date.now() + 30 * 60_000 }));
$("#exclusionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#excludedSite").value.trim();
  if (value) updateSettings({ excludedSites: [...new Set([...(dashboard?.settings?.excludedSites || []), value])] }).then((saved) => { if (saved) $("#excludedSite").value = ""; });
});
$("#keyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("#apiKey").value.trim();
  if (!key) return;
  try { await send("SAVE_API_KEY", { key }); $("#apiKey").value = ""; notify("Gemini key saved in extension-only storage."); await refresh(); }
  catch (error) { notify(error.message, true); }
});
$("#clearKey").addEventListener("click", async () => {
  try { await send("CLEAR_API_KEY"); notify("Gemini key cleared."); await refresh(); }
  catch (error) { notify(error.message, true); }
});
$("#analysisForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await send("ANALYZE_URL", { url: $("#analysisURL").value.trim() });
    renderJob(response.job);
  } catch (error) { $("#analysisStatus").textContent = error.message; }
});
$("#exportData").addEventListener("click", async () => {
  try {
    await repository.open();
    const data = await repository.exportData(dashboard?.settings ?? {});
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `watchwise-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    notify("History exported.");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Watchwise could not export your history.", true);
  }
});
$("#deleteData").addEventListener("click", async () => {
  if (!confirm("Delete all local Watchwise viewing history and analysis jobs? This cannot be undone.")) return;
  try { await send("DELETE_HISTORY"); notify("Local history deleted."); await refresh(); }
  catch (error) { notify(error.message, true); }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DASHBOARD_UPDATED") refresh();
  if (message?.type === "ANALYSIS_JOB_UPDATED") {
    invalidateFullStateRequests();
    renderJob(message.job);
  }
});
refresh();
