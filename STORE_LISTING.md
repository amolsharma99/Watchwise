# Chrome Web Store listing draft

This draft matches the public Watchwise package. Screenshots use clearly labelled demonstration data and the extension's own interface. The Privacy tab must link to the [published privacy policy](PRIVACY.md).

## Store listing

**Name:** Watchwise

**Short description:** See your Chrome video time, get gentle check-ins, and optionally analyse public YouTube videos with Gemini.

**Category:** Productivity

**Detailed description:**

Watchwise helps you watch with intent. Once you opt in, it measures active HTML5 video playback on HTTPS websites in Chrome, then shows your time, meaningful video starts, top sites, and the videos using the most time in a private side panel.

Get a gentle in-page goal check after about 15 seconds of active playback, plus optional nudges when viewing patterns suggest you may want to pause or skip ahead. Movie Mode, snooze, quiet hours, excluded sites, and an In-page alerts switch let you decide when Watchwise stays quiet. Watchwise does not send system notification banners.

Optional Gemini analysis can summarise a **public YouTube video** and show key moments, possible skips, and a cautious assessment of its information value. It requires your own Gemini API key and separate consent; each new analysis may use paid quota. Automatic analysis can be turned off while manual analysis remains available. These assessments are not external fact-checks.

Your viewing history and results stay in your Chrome profile. Watchwise has no account or developer-operated analytics server. You can export your data or delete local history whenever you choose. Gemini analysis sends the selected public YouTube URL and prompt directly to Google's API using your key.

Watchwise works with ordinary HTML5 video players on HTTPS sites. Some DRM, canvas, custom, or inaccessible embedded players may not be detected. Gemini analysis is currently limited to public YouTube videos.

## Privacy tab responses

**Single purpose:** Help users understand and reduce passive video watching in Chrome through local viewing insights, in-page nudges, and optional analysis of public YouTube videos.

**Data handled:** Website content (limited video titles and metadata), web history/browsing activity (eligible video URLs and sites), user activity (playback events and viewing time), and authentication information (an optional user-supplied Gemini API key). Viewing data is local to the browser profile. The optional Gemini request transmits the public YouTube URL, prompt, and API key directly to Google; Google returns the analysis. No data is sold, used for ads, or sent to a Watchwise server.

**Permission reasons:** `https://*/*` is required to detect HTML5 video on HTTPS websites and in frames and to show in-page alerts. `storage` keeps settings and an optional key locally. `sidePanel` displays the dashboard. `alarms` resumes pending Gemini jobs, refreshes insights, and prunes records after 180 days. `scripting` repairs consent-gated tracking in already-open eligible tabs after extension reload. The user-initiated JSON export uses a browser Blob download without a separate downloads permission.

**Privacy policy URL after publishing:** `https://github.com/amolsharma99/Watchwise/blob/main/PRIVACY.md`

## Reviewer test instructions

1. Install and click the Watchwise toolbar icon. The side panel explains HTTPS access; turn on local tracking. AI is optional and off until separately enabled.
2. Play a public YouTube watch-page video in the active Chrome tab for at least 20 seconds. The Overview records active time and a meaningful start after at least three seconds of actual playback. With In-page alerts enabled and interruption controls off, a brief goal check-in appears in the page after about 15 seconds of actual playback. Seeking ahead does not count as watched time.
3. Open Settings to inspect Movie Mode, snooze, quiet hours, site exclusions, export/delete, and the independent AI switches. The extension does not require an account, API key, or payment to test tracking and nudges.
4. Optional AI test: provide a Gemini API key with sufficient quota, enable AI consent, and manually analyse a public YouTube URL. Analysis may consume paid quota; restricted videos or unavailable quota can fail. Do not request a key from the developer or paste it into a review note.

## Release fields still supplied in the dashboard

- Developer account and contact email; 2-Step Verification and registration fee if this is the first item.
- Public visibility and intended regions.
- At least one 1280×800 or 640×400 screenshot (up to five), plus the extension icon. Use `docs/screenshots/01-overview.png` through `05-settings.png` for the store; `06-interruption-controls.png` is for the guide only.
- Privacy declarations that match this draft and the public policy URL.

This file is preparation material, not a claim that the item has been submitted or approved.
