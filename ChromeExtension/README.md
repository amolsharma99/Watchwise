# Watchwise for Chrome

Watchwise is a Chrome Manifest V3 side-panel extension for intentional video viewing. It tracks visible HTML5 video playback locally, offers restrained nudges, shows daily/weekly insights and can analyse public YouTube videos with Gemini automatically or on demand.

The enduring product and UX direction for future changes is in [AGENTS.md](AGENTS.md).

## Privacy and permissions

Tracking, in-page alerts and AI consent are off by default. The automatic-analysis preference is on by default but remains inert until you explicitly enable AI analysis and save your own Gemini API key.

The extension requests access to `https://*/*` because video players can appear on almost any HTTPS site and inside cross-origin frames. This broad access is disclosed during onboarding and in Options. Content scripts observe only HTML5 `<video>` playback state and send this allow-listed telemetry to the extension background worker:

- title, public URL and hostname;
- duration, position, playback rate and play/pause/seek/end state;
- timestamp, frame identity and visibility state.

Watchwise does **not** capture screen pixels, audio, captions, arbitrary page-body text, cookies, forms or credentials. Incognito use is disabled. Tracking decisions, site exclusions and persistence are enforced by the trusted background worker; content scripts cannot read extension storage. For a Netflix `/watch/` page only, the tracker may read the exact player title metadata element when standard video, Media Session and document metadata remain generic.

Viewing events and analysis jobs are stored in IndexedDB. Settings and the optional Gemini API key are stored in `chrome.storage.local` after setting its access level to `TRUSTED_CONTEXTS`. The key is never returned to content scripts, placed in URLs, logged or included in exports.

Chrome local extension storage is access-isolated from content scripts but is not an operating-system Keychain. Anyone with sufficient access to the Chrome profile or device may be able to inspect it; clear the key when it is not needed.

## Load unpacked

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `ChromeExtension` directory.
4. Pin Watchwise if desired, then click its toolbar icon to open the side panel.
5. Review the HTTPS access disclosure and choose whether to enable local tracking.
6. Optional: enable Gemini analysis and save your Gemini API key in Settings. New visible, active public YouTube videos are then analysed automatically unless you turn automatic analysis off. The manual **Analyse** action remains available.

### Updating the unpacked build to v0.3.9

1. Open `chrome://extensions`, find Watchwise and click **Reload** on its card.
2. Close any open Watchwise side panel, then reopen it from the toolbar icon.
3. Verify the header reads **v0.3.9**. If it shows an older version or an update warning, close the panel and reload the extension again before testing.
4. Reload any already-open YouTube or Netflix video tabs once. This clears an older content-script instance that Chrome may have invalidated during an extension reload.

Version 0.3.9 makes the 15-second goal check-in commit only after the in-page toast confirms it was appended. Goal toasts take priority over an unrelated toast cooldown, work inside container-based fullscreen players, and use a durable pending lease with bounded retry after a transient delivery failure. Direct `<video>` or replaced `<iframe>` fullscreen fails closed because extension DOM may not render there; the pending check-in may retry after fullscreen exit. Unverified v0.3.8 goal state is discarded during this upgrade, so a video whose v0.3.8 toast was actually visible may receive one repeat check-in. This release also removes all Chrome/macOS native banners: the alert toggle now controls in-page nudges and analysis-ready toasts only. The v0.3.7 invalidated-context cleanup, v0.3.6 Netflix title extraction and v0.3.5 eligible-tab recovery remain intact. Chrome cannot retroactively repair a content script orphaned by an older extension reload, so existing affected video tabs still need the one-time reload above.

Reloading the unpacked extension does not delete its local history. Use **Delete history** in Watchwise only when you intentionally want a clean test.

### On-device AI quality trial

The repository retains a source-only Labs/developer trial page for Chrome's Summarizer and Prompt APIs, using a bundled public English auto-generated transcript from a four-minute YouTube video. It is not linked from the public Watchwise UI and is excluded from the Chrome Web Store package. The trial does not call Gemini API and does not save or change Watchwise analysis jobs or settings. The page does not probe Chrome's local models or load the transcript on page load: choose **Check local AI availability** first. It shows the base Prompt API state and, when the base API is runnable, the configured task state. It enables an action only when the matching task is available, downloadable or downloading. A model-capability/adaptation warning means Chrome's on-device model or configured task is unavailable. This local trial is separate from Watchwise tracking and Gemini analysis, and it never falls back to Gemini. Chrome may still write its own native model-capability warning to DevTools after an explicit check even when Watchwise handles the result; that browser message cannot be suppressed by the extension.

### Safe Gemini live test

No live Gemini request or credential was used while building or testing Watchwise. If you choose to run one controlled request with your own key:

1. Reload the unpacked extension, reopen the side panel and verify **v0.3.9** in the header.
2. Turn **Analyse new YouTube videos automatically** off so playback cannot create an extra request.
3. Turn AI consent on, end Movie Mode, and confirm `youtube.com` is not excluded.
4. Save your own Gemini API key in Watchwise.
5. Paste Google's public sample URL, `https://www.youtube.com/watch?v=9hE5-98ZeCg`, into the manual analysis field.
6. Click **Analyse with Gemini** once, wait for the asynchronous result, and use Refresh if needed. Do not click repeatedly.

For troubleshooting, never share the API key, request headers, or request/response body. Share only Watchwise's safe error message and, if available in Chrome DevTools, the HTTP status for the single Interactions `POST` or subsequent `GET`.

Gemini API requests use your key and may consume paid quota or incur charges under your Google account. Watchwise submits at most one durable automatic job per canonical YouTube video in local history, including across service-worker restarts and concurrent frames. Movie Mode, site exclusions, missing consent, a missing key, paused/offscreen playback, and the automatic-analysis toggle prevent automatic submission.

No Chrome profile is modified by the project scripts, and there is no native host or Mac app dependency.

## Behaviour

- The side panel focuses on time spent, meaningful starts, and the most-watched videos, with weekly context, site totals, Movie Mode, settings and analysis nearby. A start is counted only after visible playback demonstrates at least three seconds of progress; metadata events and near-contiguous DOM replacements are not starts.
- YouTube homepage/feed playback without a canonical video ID is rejected before local persistence because it is commonly an automatic preview and cannot produce an honest title or link; it therefore cannot appear in insights or exports. A canonical Watch, Embed, Live or Shorts URL is required for YouTube telemetry, time, starts and breakdown rows. Generic non-YouTube HTML5 feeds remain tracked by validated session.
- Titles come from the browser Media Session title, the video element’s title/ARIA label, strict Open Graph/Twitter title metadata, or the document title. On an exact Netflix `/watch/` page, Watchwise may fall back to the exact `[data-uia="video-title"]` or `[data-uia="player-title"]` metadata element; it does not scan surrounding page text. Netflix branding and control characters are removed and titles remain capped at 300 characters. When a canonical Short exposes only generic YouTube labels, the breakdown uses **YouTube Short** and retains its canonical link.
- Daily and weekly video breakdowns show the sanitized saved title, canonical HTTPS link, site and overlap-safe active watched minutes, sorted by active time. YouTube watch, embed, Shorts, Live and `youtu.be` forms deduplicate by canonical video identity. Generic feeds remain separated by the validated session because current privacy-minimal telemetry cannot reliably prove two generic players are the same media. Simultaneous wall time is split evenly among unique active video identities, so row totals equal the overall active watching time.
- Movie Mode, snooze and quiet hours silence interventions; local accounting continues while tracking remains enabled.
- After 15 seconds of plausible positive media progress while the video is visible and its tab/window are active, Watchwise may show the exact check-in: **Hope you’re clear on your goal for watching this video.** Seek jumps, paused/hidden playback, separate tabs and viewing episodes more than 30 seconds apart do not combine toward the threshold. YouTube watch/embed/Shorts/Live forms for the same video deduplicate across frames and player replacements; generic sites use the validated session.
- The goal check-in is processed at most once per video identity in 24 hours and keeps only the latest 200 processed identities. A 60-second anti-spam gap applies across goal and existing nudges. A distinct video blocked only by that brief gap remains pending while actively playing and may check in after the gap; a video suppressed by tracking/in-page-alert settings, Movie Mode, snooze, quiet hours or either frame/page exclusion is marked processed and never backfilled later. This check-in is in-page only. There is no background alarm for this feature.
- With AI consent and a saved key, automatic analysis starts only after a validated public YouTube video accumulates at least three seconds of visible, active playback. It is enabled by default and can be turned off independently of manual analysis.
- Automatic requests are deduplicated by canonical YouTube video ID using durable IndexedDB jobs/results, so concurrent frames and service-worker restarts do not create repeat paid submissions. Pending remote job IDs resume polling after restarts.
- Gemini uses stored asynchronous Interactions with the text analysis instructions followed by the public video and a structured JSON response. A narrowly detected background-mode incompatibility gets one synchronous fallback under the same durable job; authentication, quota, invalid-request and other failures are never generically retried.
- Manual analysis remains useful when automatic analysis is disabled or for a different public YouTube URL.
- Nudges and analysis-ready alerts are in-page toasts only; Watchwise requests no native-notification permission. If the saved source tab has closed or cannot receive the toast, a completed analysis remains durable and visible in the side panel, but Watchwise sends no out-of-browser alert.
- Exports contain viewing history, analysis jobs/results and safe settings; never the API key.

## Limitations

- DRM players, canvas/WebGL players and custom players without an HTML5 `<video>` element may not be detected.
- Browser or site changes can affect player detection.
- Embedded frames that Chrome does not permit extensions to access cannot be tracked.
- Information-value and “misleading” signals are cautious model assessments, not external fact-checks.
- Gemini URL analysis is limited to public YouTube videos. Tracking still covers ordinary HTML5 videos across HTTPS sites.
- A successful live Chrome installation and live Gemini call were not performed in this build environment. Automated module tests and static JavaScript checks do not replace a manual Chrome acceptance pass.
