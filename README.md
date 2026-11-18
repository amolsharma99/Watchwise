# Watchwise for Chrome

Watchwise is a Chrome-only extension; no Mac app or native bridge is needed. The Chrome Web Store edition is local-only: after you opt in, it tracks visible HTML5 video on HTTPS websites and shows daily and weekly insights, restrained in-page nudges, and Movie Mode in a side panel. It keeps encrypted viewing records and settings in your Chrome profile and makes no remote AI or analytics requests.

The Store edition lives in [`ChromeExtension/store-local`](ChromeExtension/store-local). Its [user guide](store/USER_GUIDE.md), [privacy policy](store/PRIVACY.md), and [listing draft](store/LISTING.md) describe the public package. Publication status is tracked in [RELEASE_PLAN.md](RELEASE_PLAN.md). The Store item is not yet approved, so there is no install link.

## Try the experimental development build

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select the [`ChromeExtension`](ChromeExtension) folder.
3. Click the Watchwise toolbar icon to open its side panel.
4. Review the broad HTTPS site-access notice and opt in to tracking. In-page alerts and Gemini are separate optional switches.
5. Watch videos normally. The side panel shows your local history and controls.

The experimental build includes Gemini. It requires your own API key and explicit AI consent. Once both are configured, it automatically starts asynchronous analysis after at least three seconds of visible, active playback on a public YouTube video; the independent automatic-analysis switch can turn this off, and the manual **Analyse** action remains available. Each new video can consume paid Gemini quota. The extension stores the key in Chrome's local extension storage, not macOS Keychain. Summary text stays in the side panel; a brief in-page toast can tell you when it is ready if the source tab is still open. Watchwise sends no system notification banners. This build is not the public Store release.

Tracking runs in Chrome only. It depends on a visible HTML5 `<video>` element with a finite duration; protected or custom players and live streams may not be counted reliably. A Chrome Web Store release and live browser acceptance testing are still outstanding. The current folder is a development extension, not a published install link.

See the experimental build's [user guide](USER_GUIDE.md), [privacy policy](PRIVACY.md), and [extension developer notes](ChromeExtension/README.md). The previous Swift Mac app and native bridge remain in `Sources/` and `BrowserExtension/` as legacy source; they are not required by this Chrome-only build.

## Verification

For the local-only Store edition, run from this directory:

```sh
ruby ChromeExtension/tests/local_store_check.rb
ruby ChromeExtension/tests/run_local_store_jsc.rb
ruby ChromeExtension/tests/run_local_store_chrome.rb
```

The last check uses a temporary local page in headless Google Chrome to exercise real WebCrypto and IndexedDB. For the experimental build, run:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m ChromeExtension/tests/run.mjs
ruby ChromeExtension/tests/integration_check.rb
```

These checks do not replace a live Chrome test of side-panel playback and in-page alerts, or Gemini in the experimental build.
