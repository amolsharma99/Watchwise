"use strict";
const api = globalThis.browser ?? globalThis.chrome;
const NATIVE_HOST = "com.watchwise.bridge";
let nativePort = null;

function disconnectNative() {
  if (nativePort) nativePort.disconnect();
  nativePort = null;
}

function sendToNative(payload) {
  if (!api.runtime.connectNative) return;
  try {
    if (!nativePort) {
      nativePort = api.runtime.connectNative(NATIVE_HOST);
      const connectedPort = nativePort;
      connectedPort.onDisconnect.addListener(() => {
        if (nativePort === connectedPort) nativePort = null;
      });
    }
    nativePort.postMessage(payload);
  } catch (_) {
    disconnectNative();
  }
}

api.runtime.onInstalled.addListener(async () => {
  const existing = await api.storage.local.get(["trackingEnabled", "nativeBridgeEnabled"]);
  await api.storage.local.set({
    trackingEnabled: existing.trackingEnabled ?? false,
    nativeBridgeEnabled: existing.nativeBridgeEnabled ?? false
  });
});

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.trackingEnabled?.newValue === false || changes.nativeBridgeEnabled?.newValue === false) {
    disconnectNative();
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== "watchwise.playback") return false;
  (async () => {
    const settings = await api.storage.local.get(["trackingEnabled", "nativeBridgeEnabled"]);
    if (!settings.trackingEnabled) return sendResponse({ accepted: false, reason: "tracking_disabled" });
    const payload = { ...message.payload };
    try {
      const topLevelURL = new URL(sender.tab?.url ?? "");
      if (topLevelURL.protocol === "https:") payload.pageSite = topLevelURL.hostname.toLowerCase();
    } catch (_) {
      // The native decoder treats pageSite as optional for older browsers.
    }
    // Do not persist playback metadata in extension storage. The native host
    // is the only persistence boundary and rechecks app consent/exclusions.
    if (settings.nativeBridgeEnabled) sendToNative(payload);
    sendResponse({ accepted: true });
  })();
  return true;
});
