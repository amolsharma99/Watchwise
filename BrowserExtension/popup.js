"use strict";
const api = globalThis.browser ?? globalThis.chrome;
const tracking = document.querySelector("#tracking");
const bridge = document.querySelector("#bridge");
const status = document.querySelector("#status");

async function refresh() {
  const settings = await api.storage.local.get(["trackingEnabled", "nativeBridgeEnabled"]);
  tracking.checked = settings.trackingEnabled === true;
  bridge.checked = settings.nativeBridgeEnabled === true;
  status.textContent = !tracking.checked
    ? "Tracking is off."
    : bridge.checked
      ? "Playback accounting is enabled."
      : "Tracking is on, but no history is saved until the Mac app connection is enabled.";
}

tracking.addEventListener("change", async () => {
  await api.storage.local.set({ trackingEnabled: tracking.checked });
  status.textContent = tracking.checked
    ? (bridge.checked ? "Tracking enabled for visible HTML5 videos." : "Tracking is on; connect the Mac app to save history.")
    : "Tracking is off.";
});
bridge.addEventListener("change", async () => {
  await api.storage.local.set({ nativeBridgeEnabled: bridge.checked });
  status.textContent = bridge.checked ? "Mac app connection enabled." : "Mac app connection disabled; no history is saved.";
});
refresh();
