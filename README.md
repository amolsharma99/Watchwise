# Watchwise for Chrome

Watchwise is now a Chrome-only extension. Install the `ChromeExtension` folder once in Chrome; no Mac app or native bridge is needed. It tracks visible HTML5 video on HTTPS websites after you opt in, then shows daily and weekly insights, restrained nudges, Movie Mode, and optional Gemini summaries in a translucent side panel.

## Try the development build

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select the [`ChromeExtension`](ChromeExtension) folder.
3. Click the Watchwise toolbar icon to open its side panel.
4. Review the broad HTTPS site-access notice and opt in to tracking. Notifications and Gemini are separate optional switches.
5. Watch videos normally. The side panel shows your local history and controls.

The Gemini feature requires your own API key and explicit AI consent. Once both are configured, Watchwise automatically starts an asynchronous analysis after at least three seconds of visible, active playback on a public YouTube video; the independent automatic-analysis switch can turn this off, and the manual **Analyse** action remains available. Each new video can consume paid Gemini quota. The extension stores the key in Chrome's local extension storage, not macOS Keychain. Summary text stays in the side panel; a brief system notification can tell you when it is ready. Chrome controls the appearance of system notifications, while the side panel and in-page nudges use translucent styling.

Tracking runs in Chrome only. It depends on a visible HTML5 `<video>` element with a finite duration; protected or custom players and live streams may not be counted reliably. A Chrome Web Store release and live browser acceptance testing are still outstanding. The current folder is a development extension, not a published install link.

See [the extension guide](ChromeExtension/README.md) for privacy details and limitations. The previous Swift Mac app and native bridge remain in `Sources/` and `BrowserExtension/` as legacy source; they are not required by this Chrome-only build.

## Verification

Run from this directory:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m ChromeExtension/tests/run.mjs
ruby ChromeExtension/tests/integration_check.rb
```

These exercise the domain logic and static Chrome integration contract. They do not replace a live Chrome test of playback, notifications, IndexedDB, and Gemini.
