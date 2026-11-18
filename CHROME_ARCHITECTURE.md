# Watchwise Chrome-only architecture and acceptance plan

## Product boundary

The normal product is one unpacked or Web Store Manifest V3 Chrome extension under `ChromeExtension/`. No macOS application or native-messaging host is required. Existing Swift and `BrowserExtension/` sources remain as legacy reference and are not loaded by the Chrome-only build.

## Runtime boundaries

- A consent-gated content script observes only visible standard HTML5 video timing across HTTPS frames. It never reads settings/secrets directly and never captures pixels, audio, captions, cookies, forms or page bodies.
- A module service worker validates messages, persists events/jobs to IndexedDB, owns settings/secrets, schedules alarms, calls Gemini only after an explicit user action, and emits rate-limited Chrome notifications/toast messages.
- A side panel owns onboarding, controls, insights, analysis submission/results, export and deletion.
- `chrome.storage.local` contains settings and the optional user-supplied Gemini key. Access is restricted to trusted extension contexts. The key is never exported, logged, placed in a URL or delivered to content scripts.
- IndexedDB contains playback telemetry and restart-safe analysis jobs/results.

## Acceptance criteria

- Manifest V3 has no `nativeMessaging` permission and uses only the documented HTTPS/Gemini hosts plus required Chrome APIs.
- Tracking, notifications and AI default off; incognito is disabled.
- Turning tracking off stops content telemetry, not merely persistence.
- Exclusions apply to both the top-level page and embedded-player site.
- Concurrent frames/players do not double-count wall-clock viewing; distinct player IDs on a feed remain separate sessions.
- Nudge cooldown/hourly limits and Movie Mode, snooze, quiet hours, exclusions and notification-off are enforced centrally.
- Slow/skip guidance requires structured analysis evidence and never fires from playback speed alone.
- Queued/remote analysis jobs survive worker restart and are resumed by alarms. No analysis occurs without the user pressing Analyse.
- Gemini results are schema-validated, bounded, cautious, and always disclose that no external fact-check was performed.
- Side panel supports daily/weekly insights, API-key save/clear, notification controls, exclusions, export and deletion.
- Completion notifications are brief and open the richer side-panel result; system notification styling is not misrepresented.
- Node-free deterministic verification covers validation, storage adapter behavior, insights, suppression, session isolation and restart serialization. No live Gemini request is made.

## Release limitation

Source and deterministic tests can be verified here. A final release still requires manual load-unpacked smoke testing in Chrome, site-specific checks for representative players, Web Store packaging and a user-supplied Gemini key for an explicit live API test. DRM/custom/canvas/live players may not expose reliable HTML5 telemetry.
