# Watchwise privacy policy

Last updated: 18 November 2026

Watchwise is a Chrome extension that helps you understand and reduce passive video watching. It has no Watchwise account, advertising, analytics service, or developer-operated server. Its viewing history stays in the Chrome profile on your device. This policy covers the **experimental AI-enabled source build**. The proposed local-only Chrome Web Store edition has its own [privacy policy](store/PRIVACY.md).

## What Watchwise handles

Tracking is **off until you opt in**. When enabled, Watchwise detects visible HTML5 video playback on HTTPS websites and records the video title (when available), a canonical HTTPS video URL, site, playback position and duration, playback speed, play/pause/seek state, visibility, and timestamps. It uses these records to calculate active watching time, meaningful video starts, site and video breakdowns, and in-page nudges. It does not record every page you visit: pages without eligible video playback do not become viewing-history entries. You can exclude sites and turn tracking off at any time.

To find a useful title, Watchwise reads video attributes, the browser's Media Session title, page title metadata, and, on Netflix `/watch/` pages only, exact player-title metadata elements. It does not scan arbitrary page text. It does not capture screen pixels, audio, captions, form entries, cookies, passwords, or payment information. Incognito use is disabled.

Viewing events, analysis jobs, and results are stored in the extension's local IndexedDB. Settings and an optional Gemini API key are stored in Chrome extension local storage. The key is not included in exports, page content, URLs, or Watchwise logs. Chrome profile/device access may still expose local storage; it is not a system Keychain.

## Optional Gemini analysis

Gemini analysis requires separate consent **and your own API key**. Automatic analysis is enabled as a preference, but cannot run until you enable AI consent and save a key; you can switch automatic analysis off and still use the manual Analyse action. When an eligible public YouTube video is analysed, Watchwise sends its public YouTube URL, an analysis prompt and your API key directly from your browser to Google's Gemini API. The request asks Google to store the interaction so asynchronous processing can be polled. Google processes that request and returns a summary, key moments, possible skips, and a cautious information-value assessment; Watchwise saves the result locally. No viewing-history export or non-YouTube page content is sent to Gemini.

The Gemini feature may use paid API quota or incur charges on your Google account. Google's [Gemini API terms](https://aistudio.google.com/docs/terms) say that, for unpaid service, submitted inputs and outputs may be used to improve Google's products and may be reviewed by humans; paid-service data is handled differently under those terms. The request uses stored interactions for asynchronous processing. Watchwise's **Delete history** action removes local analysis records but cannot remove interactions already held by Google; manage those through your Google AI project. Summaries and verdicts are model assessments, not external fact-checks.

## Sharing, retention, and your controls

Watchwise does not send viewing history or your API key to the Watchwise developer, sell data, or use it for advertising. The only third-party transfer initiated by Watchwise is the optional Gemini request described above. An explicit **Export JSON** action downloads a local copy of your history, analysis records, and safe settings; it excludes the API key.

Watchwise automatically removes local playback events older than 180 days, completed analysis results older than 180 days, and finished analysis jobs whose last update is older than 180 days. An unfinished job may remain until it completes or you delete history. You can use **Delete history** sooner or remove the extension/profile. Delete history does not clear your saved API key or preferences; use **Clear saved key** separately. Disabling tracking stops new tracking but does not erase existing history. Movie Mode, snooze, quiet hours, site exclusions, and the In-page alerts switch control interruptions. Watchwise does not send macOS or Chrome system notifications.

Watchwise requests HTTPS website access to detect videos across sites and embedded frames. Other extension permissions support local settings, the side panel, alarms for pending Gemini work, and recovery of tracking in already-open tabs. You can initiate a local JSON export. The [user guide](USER_GUIDE.md) explains these controls and the feature limits.

Watchwise's use of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

For questions or privacy requests, open an issue at [Watchwise on GitHub](https://github.com/amolsharma99/Watchwise/issues). Do not include your API key or private viewing history in an issue.
