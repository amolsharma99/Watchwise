const tracking = document.querySelector("#tracking");
const notifications = document.querySelector("#notifications");
const status = document.querySelector("#status");

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Unable to update Watchwise.");
  return response;
}

async function load() {
  try {
    const { state } = await send("GET_DASHBOARD_STATE");
    tracking.checked = state.settings.trackingEnabled;
    notifications.checked = state.settings.notificationsEnabled;
  } catch (error) { status.textContent = error.message; }
}

for (const [element, key] of [[tracking, "trackingEnabled"], [notifications, "notificationsEnabled"]]) {
  element.addEventListener("change", async () => {
    try {
      await send("UPDATE_SETTINGS", { patch: { [key]: element.checked } });
      status.textContent = "Saved.";
    }
    catch (error) { status.textContent = error.message; }
  });
}
document.querySelector("#openPanel").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) throw new Error("No active Chrome window.");
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) { status.textContent = error.message; }
});
load();
