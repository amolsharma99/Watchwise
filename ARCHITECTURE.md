# Watchwise architecture and acceptance plan

## Product boundary

Watchwise is a privacy-first macOS menu-bar app plus a Safari/Chromium WebExtension. It records playback telemetry only after the user opts in. It never captures the screen, microphone, protected media, page text, or credentials. The browser component reports a minimal allow-listed event schema to the native app. Analysis is optional and supports a deterministic mock as well as a Gemini transport configured with a user-supplied key held in Keychain.

## Components

1. `WatchwiseCore` owns domain models, local SQLite persistence, nudge policy, notification suppression, data deletion/export, and daily/weekly insights.
2. `WatchwiseIntegrations` owns Gemini request/response contracts, asynchronous job coordination, redaction/consent checks, Keychain access, and browser-event decoding.
3. `WatchwiseApp` is the SwiftUI menu-bar/dashboard surface. It presents consent before tracking or AI use, friendly actionable nudges, Movie Mode, snooze, notification controls, exclusions, and insight cards.
4. `BrowserExtension` observes visible HTML5 video playback on HTTPS pages and embedded HTTPS frames. It sends only title, canonical URL, player-frame site, top-level page site, duration, position, rate, playback state, and a random per-player ID. It contains no network analytics and does not persist playback metadata in extension storage.

## Security and privacy invariants

- Tracking and Gemini analysis default to off until consented.
- No API key or secret is committed, logged, or stored outside Keychain.
- Only `https` public URLs are eligible for remote URL analysis.
- Private/local URLs, excluded sites, and movie-mode sessions are not submitted.
- “Misleading” is never asserted as fact: assessments carry evidence, confidence, and a caveat that external fact-checking was not performed.
- Notifications respect the global switch, Movie Mode, snooze, quiet hours, and per-site exclusions.
- Stored history can be exported and deleted locally.
- SQL uses bound parameters; decoded events have length/range validation.

## Acceptance criteria

- Swift package builds on the available Swift 6 toolchain and all automated tests pass.
- Playback event ingestion produces correct active-watch duration without counting pauses.
- Nudge rules cover daily limit, long session, rabbit-hole, and low-density/slow viewing without notification flooding.
- Movie Mode and global notification-off suppress all nudges and notifications.
- Daily and weekly insight totals are deterministic and timezone-aware.
- Async analysis transitions through queued/running/succeeded/failed states and can notify on completion.
- AI output includes summary, timestamped key points/skip suggestions, value verdict, confidence, evidence, and safety caveat.
- Extension scripts pass syntax/contract tests and do not collect page content beyond the allow-listed fields.
- README documents permissions, local run/test steps, browser installation, Gemini configuration, privacy limits, and unsigned-app packaging requirements.

## Delivery constraint

This environment has the Swift toolchain but may not have the full Xcode GUI/signing setup. We will verify the Swift package, tests, extension contract, and runnable development executable. Producing a notarized `.app` and App Store/Safari-extension package remains a documented Xcode signing step.
