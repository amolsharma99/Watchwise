# Watchwise for Chrome

Watchwise is a Chrome Manifest V3 side-panel extension for intentional video viewing. It tracks visible HTML5 video playback locally, offers restrained nudges, shows daily/weekly insights and provides a user-initiated Gemini AI Studio handoff for public YouTube videos. Optional Gemini API analysis can also run automatically with consent and a saved key.

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
6. Optional: enable Gemini API analysis and save your Gemini API key in Settings. New visible, active public YouTube videos are then analysed automatically unless you turn automatic analysis off. The separate **Summarise in Gemini AI Studio** action on YouTube does not require the key.

### Updating the unpacked build to v0.3.16

1. Open `chrome://extensions`, find Watchwise and click **Reload** on its card.
2. Close any open Watchwise side panel, then reopen it from the toolbar icon.
3. Verify the header reads **v0.3.16**. If it shows an older version or an update warning, close the panel and reload the extension again before testing.
4. Reload any already-open YouTube or Netflix video tabs once. This clears an older content-script instance that Chrome may have invalidated during an extension reload.

Version 0.3.9 makes the 15-second goal check-in commit only after the in-page toast confirms it was appended. Goal toasts take priority over an unrelated toast cooldown, work inside container-based fullscreen players, and use a durable pending lease with bounded retry after a transient delivery failure. Direct `<video>` or replaced `<iframe>` fullscreen fails closed because extension DOM may not render there; the pending check-in may retry after fullscreen exit. Unverified v0.3.8 goal state is discarded during this upgrade, so a video whose v0.3.8 toast was actually visible may receive one repeat check-in. This release also removes all Chrome/macOS native banners: the alert toggle now controls in-page nudges and analysis-ready toasts only. The v0.3.7 invalidated-context cleanup, v0.3.6 Netflix title extraction and v0.3.5 eligible-tab recovery remain intact. Chrome cannot retroactively repair a content script orphaned by an older extension reload, so existing affected video tabs still need the one-time reload above.

Reloading the unpacked extension does not delete its local history. Use **Delete history** in Watchwise only when you intentionally want a clean test.

Version 0.3.10 brings the Ink & caramel design and eye-play icon to this existing unpacked installation. Each standard YouTube watch page has an **Ask in AI Studio** button. Clicking it copies a concise, video-specific prompt and opens Google AI Studio for you to paste and send. Watchwise does not automate Studio or receive its answer. The button does not appear on Shorts or other YouTube pages and works independently of the optional Gemini API analysis setting.

Version 0.3.11 opens AI Studio's new-chat page directly. The previous root URL could redirect a signed-in user to the Usage dashboard, hiding the prompt box after the clipboard handoff.

Version 0.3.12 calls the action **Summarise in Gemini AI Studio**. After a click, Watchwise opens a new AI Studio chat and places the prepared prompt in its empty composer. You review and press **Run** yourself; Watchwise never submits it or reads the answer. It also tries to copy the prompt as a fallback. The prompt contains only a canonical public YouTube URL and instructions, with no title or viewing history. A short-lived `chrome.storage.session` record is scoped to the new Studio tab, expires after two minutes, and is removed after handling or when the tab closes. The prompt becomes visible to Google's AI Studio page as soon as it is inserted, before you press Run. If Studio changes its composer or already contains text, Watchwise leaves that text untouched and shows a manual-copy fallback.

Version 0.3.13 uses the exact prompt `Summarise the video with topics and bullets for each - {url}` in both the Studio composer and clipboard fallback, with `{url}` replaced by the canonical public YouTube watch URL.

Version 0.3.14 removes the Analyse tab and its manual Gemini API form. The side panel now has Overview and Settings. Automatic Gemini API analysis remains optional; its latest job and result are available under the collapsed **Latest Gemini API analysis** section in Settings. The YouTube **Summarise in Gemini AI Studio** button continues to work independently.

Version 0.3.15 keeps the Studio button at a fixed size after clicking. Brief progress feedback and the rare manual-copy fallback float outside YouTube's action row. A successful Studio opening clears the feedback even if clipboard copying was blocked; returning to the video also clears stale feedback.

Version 0.3.16 additionally clears stale fallback feedback when Chrome restores a video page from its back-forward cache.

### On-device AI quality trial

The repository retains a source-only Labs/developer trial page for Chrome's Summarizer and Prompt APIs, using a bundled public English auto-generated transcript from a four-minute YouTube video. It is not linked from the public Watchwise UI and is excluded from the Chrome Web Store package. The trial does not call Gemini API and does not save or change Watchwise analysis jobs or settings. The page does not probe Chrome's local models or load the transcript on page load: choose **Check local AI availability** first. It shows the base Prompt API state and, when the base API is runnable, the configured task state. It enables an action only when the matching task is available, downloadable or downloading. A model-capability/adaptation warning means Chrome's on-device model or configured task is unavailable. This local trial is separate from Watchwise tracking and Gemini analysis, and it never falls back to Gemini. Chrome may still write its own native model-capability warning to DevTools after an explicit check even when Watchwise handles the result; that browser message cannot be suppressed by the extension.

### Safe Gemini live test

If you choose to run one controlled Gemini API request with your own key:

1. Reload the unpacked extension, reopen the side panel and verify **v0.3.16** in the header.
2. Turn **Analyse new YouTube videos automatically** on, enable AI consent, end Movie Mode, and confirm `youtube.com` is not excluded.
3. Save your own Gemini API key in Watchwise.
4. Play a new public YouTube watch video in an active tab for at least three seconds. Open **Settings → Latest Gemini API analysis** to see its status or result. Requests may use quota.

For troubleshooting, never share the API key, request headers, or request/response body. Share only Watchwise's safe error message and, if available in Chrome DevTools, the HTTP status for the single Interactions `POST` or subsequent `GET`.

Gemini API requests use your key and may consume paid quota or incur charges under your Google account. Watchwise submits at most one durable automatic job per canonical YouTube video in local history, including across service-worker restarts and concurrent frames. Movie Mode, site exclusions, missing consent, a missing key, paused/offscreen playback, and the automatic-analysis toggle prevent automatic submission.

No Chrome profile is modified by the project scripts, and there is no native host or Mac app dependency.

## Behaviour

- The side panel has Overview and Settings. Overview focuses on time spent, meaningful starts, the most-watched videos, weekly context and site totals. A start is counted only after visible playback demonstrates at least three seconds of progress; metadata events and near-contiguous DOM replacements are not starts.
- YouTube homepage/feed playback without a canonical video ID is rejected before local persistence because it is commonly an automatic preview and cannot produce an honest title or link; it therefore cannot appear in insights or exports. A canonical Watch, Embed, Live or Shorts URL is required for YouTube telemetry, time, starts and breakdown rows. Generic non-YouTube HTML5 feeds remain tracked by validated session.
- Titles come from the browser Media Session title, the video element’s title/ARIA label, strict Open Graph/Twitter title metadata, or the document title. On an exact Netflix `/watch/` page, Watchwise may fall back to the exact `[data-uia="video-title"]` or `[data-uia="player-title"]` metadata element; it does not scan surrounding page text. Netflix branding and control characters are removed and titles remain capped at 300 characters. When a canonical Short exposes only generic YouTube labels, the breakdown uses **YouTube Short** and retains its canonical link.
- Daily and weekly video breakdowns show the sanitized saved title, canonical HTTPS link, site and overlap-safe active watched minutes, sorted by active time. YouTube watch, embed, Shorts, Live and `youtu.be` forms deduplicate by canonical video identity. Generic feeds remain separated by the validated session because current privacy-minimal telemetry cannot reliably prove two generic players are the same media. Simultaneous wall time is split evenly among unique active video identities, so row totals equal the overall active watching time.
- Movie Mode, snooze and quiet hours silence interventions; local accounting continues while tracking remains enabled.
- After 15 seconds of plausible positive media progress while the video is visible and its tab/window are active, Watchwise may show a short goal check-in. Its wording varies by broad context such as a tutorial title, a recent run of videos, or a streaming site, with at most one emoji and a clear invitation to leave an unhelpful video. It never repeats the raw video title or a watched-minute count in the toast. Seek jumps, paused/hidden playback, separate tabs and viewing episodes more than 30 seconds apart do not combine toward the threshold. YouTube watch/embed/Shorts/Live forms for the same video deduplicate across frames and player replacements; generic sites use the validated session.
- The goal check-in is processed at most once per video identity in 24 hours and keeps only the latest 200 processed identities. A 60-second anti-spam gap applies across goal and existing nudges. A distinct video blocked only by that brief gap remains pending while actively playing and may check in after the gap; a video suppressed by tracking/in-page-alert settings, Movie Mode, snooze, quiet hours or either frame/page exclusion is marked processed and never backfilled later. This check-in is in-page only. There is no background alarm for this feature.
- With AI consent and a saved key, automatic API analysis starts only after a validated public YouTube video accumulates at least three seconds of visible, active playback. It is enabled by default and can be turned off independently of the Studio handoff.
- Automatic requests are deduplicated by canonical YouTube video ID using durable IndexedDB jobs/results, so concurrent frames and service-worker restarts do not create repeat paid submissions. Pending remote job IDs resume polling after restarts.
- Gemini uses stored asynchronous Interactions with the text analysis instructions followed by the public video and a structured JSON response. A narrowly detected background-mode incompatibility gets one synchronous fallback under the same durable job; authentication, quota, invalid-request and other failures are never generically retried.
- The **Summarise in Gemini AI Studio** button on standard YouTube watch pages remains available when automatic API analysis is disabled.
- Nudges and analysis-ready alerts are in-page toasts only; Watchwise requests no native-notification permission. If the saved source tab has closed or cannot receive the toast, a completed analysis remains durable and visible in the side panel, but Watchwise sends no out-of-browser alert.
- Exports contain viewing history, analysis jobs/results and safe settings; never the API key.

## Limitations

- DRM players, canvas/WebGL players and custom players without an HTML5 `<video>` element may not be detected.
- Browser or site changes can affect player detection.
- Embedded frames that Chrome does not permit extensions to access cannot be tracked.
- Information-value and “misleading” signals are cautious model assessments, not external fact-checks.
- Gemini URL analysis is limited to public YouTube videos. Tracking still covers ordinary HTML5 videos across HTTPS sites.
- A successful live Chrome installation and live Gemini call were not performed in this build environment. Automated module tests and static JavaScript checks do not replace a manual Chrome acceptance pass.
