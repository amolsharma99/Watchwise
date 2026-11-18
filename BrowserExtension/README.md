# Watchwise WebExtension

The Chrome extension observes visible HTML5 `<video>` elements on HTTPS websites, including videos inside HTTPS iframes. Tracking defaults to **off**. Its broad `https://*/*` permission is needed for videos across sites; incognito access is disabled. It emits only the fields documented in `ARCHITECTURE.md` and makes no network requests.

This covers standard web players on sites such as YouTube, X, Instagram, Netflix, and Hotstar when those sites expose ordinary HTML5 video playback events. Site specific players, protected media, live streams without finite duration, canvas rendering, and browser UI video may not report reliably. The extension does not capture the media itself. Test each service you use before relying on its totals.

For Chromium development, open `chrome://extensions`, enable Developer Mode, and choose **Load unpacked**. A signed release should use a Web Store package. For Safari, convert this directory with Apple's Safari Web Extension converter and configure the containing app's native-message handler.

The optional native host identifier is `com.watchwise.bridge`. Until an installed signed host is present, events remain only in extension local storage. The user must explicitly enable both tracking and **Connect to Mac app** in the popup.

Native messages are UTF-8 JSON preceded by Chromium's four-byte native-endian length framing. The JSON object contains `schemaVersion`, `title`, `url`, player-frame `site`, optional top-level `pageSite`, `duration`, `position`, `playbackRate`, `state`, `occurredAtMilliseconds`, `documentVisible`, and an optional random `playerID` used to distinguish separate videos on the same feed URL. The native side must pass the object through `BrowserEventDecoder` before persistence. Query strings are removed from most recorded URLs to reduce sensitive data collection; YouTube retains only its video ID. Playback metadata is not stored in extension storage.

## Chromium native host setup

Build `WatchwiseBridge`, then run `Scripts/generate-native-host-manifest.swift` yourself with three explicit arguments: an existing browser NativeMessagingHosts directory you selected, the absolute built bridge path, and your extension's 32-character ID. The generator never guesses a browser profile, never creates a profile directory, and contains no hard-coded extension ID.

Example shape (replace every path and ID):

```sh
Scripts/generate-native-host-manifest.swift "/explicit/path/to/NativeMessagingHosts" "/absolute/path/to/WatchwiseBridge" "abcdefghijklmnopabcdefghijklmnop"
```

The bridge reads framed messages up to 64 KiB, validates the strict event schema, re-checks the native app's `bridge-settings.json` consent/exclusions before every event, maintains per-video sessions over a persistent native port, and writes accepted events to `~/Library/Application Support/Watchwise/history.sqlite3`. Missing, corrupt, disabled, or excluded privacy settings fail closed. It never logs message bodies, titles, URLs, or secrets. Movie Mode silences nudges and AI analysis but intentionally continues local usage accounting; the separate tracking switch stops event delivery.

`Scripts/test-extension.mjs` provides additional contract checks when Node is installed. Node is not present in the current build environment, so the verified local checks use JavaScriptCore compilation plus Swift framing/decoder tests; do not treat the Node script as having run here.

`Scripts/test-bridge.rb /absolute/path/to/WatchwiseBridge` is the Node-free end-to-end check. It uses a temporary explicit database, sends multiple length-prefixed events over one persistent process, proves a stable player ID retains one session, queries `/usr/bin/sqlite3` to verify accepted rows, proves top-level-site exclusions and corrupt consent do not add rows, verifies framed responses, and confirms the bridge emits no diagnostic payload data. The bridge path argument is mandatory; omitting it exits with a usage error.
