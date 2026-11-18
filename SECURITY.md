# Security and privacy model

Watchwise is designed for personal, local-first use.

- Tracking and remote analysis require separate affirmative consent.
- When tracking is enabled, the browser extension reports the page title, canonical HTTPS URL/path, player-frame and top-level sites, and playback timing described in `ARCHITECTURE.md`. It strips query strings except the YouTube video ID. It does not capture pixels, audio, captions, cookies, form contents, or arbitrary page text, and it does not persist playback metadata in extension storage.
- Viewing history is stored locally. There is no telemetry or third-party analytics.
- A Gemini key must be supplied by the user and is stored with macOS Keychain services. It must never be placed in source, preferences, logs, or the extension.
- Remote analysis accepts only public HTTPS URLs. Localhost, private-network hosts, file URLs, embedded credentials, and excluded sites are rejected.
- Gemini value assessments are advisory. They include confidence, supporting signals, and a reminder that no external fact-checking was performed.

## Reporting a problem

Do not include viewing history, URLs, API keys, or database files in a bug report. Describe the behavior and provide a synthetic reproduction instead.
