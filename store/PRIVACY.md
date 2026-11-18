# Watchwise Chrome Web Store privacy policy

Last updated: 18 November 2026

This policy covers the **local-only Watchwise Chrome Web Store edition**. It helps you notice and reduce passive video watching. It has no account, advertising, analytics service, developer-operated server, Gemini integration, or API-key field.

## What is recorded

Tracking is off until you opt in. When enabled, Watchwise detects visible HTML5 video playback on HTTPS websites and saves an eligible video's title when available, canonical HTTPS URL, site, playback position and duration, speed, play/pause/seek state, visibility, and timestamps. It uses those records to show active watching time, meaningful video starts, site/video breakdowns, and in-page nudges. Pages without eligible video playback do not become viewing-history entries. You may exclude sites or turn tracking off at any time.

To find a useful title, Watchwise reads video attributes, the browser's Media Session title, page title metadata, and, on Netflix `/watch/` pages only, exact player-title metadata elements. It does not scan arbitrary page text. It does not capture screen pixels, audio, captions, forms, cookies, passwords, or payment information. Incognito use is disabled.

## Storage, sharing, and retention

Viewing events and settings are encrypted with AES-256-GCM and kept in local IndexedDB in your Chrome profile. The non-extractable encryption key is stored in a separate IndexedDB store in the same Chrome profile. This protects the stored records at rest; it is not a password or a separate-device security boundary, and someone with access to your unlocked Chrome profile may still access the data. Watchwise does not send viewing history to its developer or a third party, sell data, or use it for ads. It makes no remote analytics or AI requests.

Watchwise automatically removes local playback events older than 180 days. You can remove them sooner with **Delete history**, or remove the extension/profile. Turning tracking off stops new collection but does not erase existing history. **Export JSON** downloads an unencrypted JSON copy of your history and safe settings when you click it; keep that file private. Movie Mode, snooze, quiet hours, excluded sites, and the In-page alerts switch control interruptions; Watchwise does not send Chrome or macOS system notification banners.

If the encryption key or stored data becomes unreadable, Watchwise stops tracking and offers a confirmed **Reset local Watchwise data** action. Reset permanently deletes the Store edition's local history and settings in that Chrome profile and starts again with tracking off. An unreadable database may prevent export before reset.

Watchwise requests HTTPS website access to detect videos across sites and embedded frames and show in-page alerts. `sidePanel` presents the dashboard, and `scripting` repairs consent-gated tracking in already-open eligible tabs after updates. The [Store edition user guide](USER_GUIDE.md) explains the controls and detection limits.

Watchwise handles extension user data according to the Chrome Web Store User Data Policy, including its Limited Use requirements.

For questions or privacy requests, open an issue at [Watchwise on GitHub](https://github.com/amolsharma99/Watchwise/issues). Do not include private viewing history in an issue.
