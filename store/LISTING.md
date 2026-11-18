# Chrome Web Store listing — local-only edition draft

**Do not use the older AI-enabled [listing draft](../STORE_LISTING.md) for this edition.** This text matches the proposed v0.4.0 local-only package and needs a final comparison with its built UI and screenshots.

## Store Listing tab

**Name:** Watchwise

**Short description:** See your Chrome video time and get gentle, private check-ins that help you watch with intent.

**Category:** Productivity

**Detailed description:**

Watchwise helps you notice where your video time goes. After you choose to enable local tracking, it measures active HTML5 video playback on HTTPS websites in Chrome. Its side panel shows your active time, meaningful video starts, top sites, and the videos using the most minutes, with today and week views.

Get a gentle in-page goal check after about 15 seconds of active playback, plus optional nudges when viewing patterns suggest a pause. Movie Mode, snooze, quiet hours, excluded sites, and an In-page alerts switch let you decide when Watchwise stays quiet. Watchwise does not send Chrome or macOS notification banners.

Your viewing history stays in your Chrome profile. Watchwise has no account, developer-operated analytics server, advertisements, or AI/API-key requirement. You can export local data or delete history at any time. Old playback events are automatically removed after 180 days.

Watchwise works with ordinary detectable HTML5 video on HTTPS sites, including supported YouTube pages. Some DRM, canvas, custom, or inaccessible embedded players may not be detected. The extension does not record screen pixels, audio, captions, cookies, forms, or arbitrary page text.

## Privacy tab

**Single purpose:** Help users understand and reduce passive video watching in Chrome with local viewing insights and in-page nudges.

**Data handled:** Web history/browsing activity (eligible video URLs and sites), website content (limited title metadata), and user activity (playback events and viewing time). All is stored locally in the Chrome profile. There is no remote transfer by Watchwise, advertising, sale, or developer analytics. Authentication information is **not** handled in this Store edition.

**Permission reasons:** `https://*/*` detects HTML5 video across HTTPS sites and embedded frames and shows in-page alerts. `storage` keeps consent and settings locally. `sidePanel` displays the dashboard. `scripting` restores consent-gated tracking in already-open eligible tabs after updates. No native-notification, downloads, tabs, alarms, or remote-AI permission is requested.

**Privacy policy URL after pushing:** `https://github.com/amolsharma99/Watchwise/blob/main/store/PRIVACY.md`

## Test instructions tab

1. Click the Watchwise toolbar icon to open the side panel. The first-run page discloses broad HTTPS access. Turn on local tracking; no account or API key is needed.
2. Play a public YouTube watch-page video in the active Chrome tab and frontmost window for at least 20 seconds. Overview records active time and a meaningful start after at least three seconds of actual playback. With In-page alerts enabled and interruption controls off, a brief goal check-in appears in the video page after about 15 seconds of actual playback. A seek jump is not counted as watched time.
3. Inspect Overview, Top sites, Video breakdown Today/Week, and Settings. Test Movie Mode, snooze, quiet hours, site exclusions, Export JSON, and Delete history.

## Distribution and upload

Choose Public visibility for general availability and regions permitted by Chrome Web Store policy. Upload the **v0.4.0 local-only ZIP**, not the v0.3.9 AI-enabled ZIP. Use the matching local-only screenshots, 640×400 or 1280×800 (maximum five), and the public privacy-policy URL above. This file is preparation material; the item has not been submitted or approved.
