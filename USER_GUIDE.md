# Watchwise user guide

Watchwise is a Chrome extension, with no Mac app to install. For the public, local-only edition, start with the [Store edition guide](store/USER_GUIDE.md). This page covers the **experimental unpacked build** in [`ChromeExtension`](ChromeExtension), which adds optional Gemini features. The two editions store data separately and should not be enabled together.

## Set up the experimental build

1. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select the repository's `ChromeExtension` folder. Click the Watchwise toolbar icon to open the side panel.
3. Read the HTTPS site-access disclosure. Enable local tracking if you want viewing insights; enable **In-page alerts** if you want nudges. Both can be turned off later.
4. After updating source files, click **Reload** on the Watchwise card and refresh already-open video tabs. Check the version in the side-panel header against [`ChromeExtension/manifest.json`](ChromeExtension/manifest.json).

The side panel has **Overview** and **Settings**. Overview shows active watching, meaningful video starts, weekly context, Top sites, and a Video breakdown with title, site, URL, and minutes in descending order. A start requires three seconds of real playback progress. Watchwise counts visible, active HTML5 video on HTTPS sites; some protected or custom players may not be detectable.

![Demonstration Overview with synthetic time and start totals](store/screenshots/01-overview.png)

## In-page check-ins

With alerts on, a translucent goal check-in can appear after about 15 seconds of actual visible playback. Seeking ahead does not count as watched time. Messages vary with the site, title, and recent viewing pattern, and the goal check-in is limited to once per video identity in 24 hours with a short gap between interruptions. Movie Mode, snooze, quiet hours, site exclusions, or switching alerts off will silence them. Movie Mode keeps tracking on.

Click **This is work** on a nudge to exclude the website in the address bar. Future playback time and nudges stop on that site, including its embedded videos. The site appears in **Settings → Excluded sites**, where you can remove it later. Time already recorded stays in your history.

![Demonstration of an in-page goal check-in](store/screenshots/03-goal-checkin.png)

## Optional automatic Gemini API analysis

In **Settings**, enable **Allow Gemini API analysis**, save your own Gemini API key, and leave **Analyse new YouTube videos automatically** on. After meaningful, visible playback of a new public YouTube watch video, Watchwise queues an asynchronous request. Open **Settings → Latest Gemini API analysis** to see the status or result. Turn the automatic switch off whenever you do not want new requests; Movie Mode and excluded sites also pause automatic analysis.

The result may include a summary, key moments, possible skips, evidence signals, and a cautious information-value verdict. It is an AI interpretation, not an independent fact check. Availability depends on Google's service, the video's accessibility, and your API quota or billing. Each request may consume paid quota. Watchwise keeps your key in Chrome extension local storage; review the [experimental privacy policy](PRIVACY.md) before enabling this feature. The public Store edition has no Gemini API integration or key field.

## Data and troubleshooting

**Export JSON** downloads viewing and analysis records with safe settings, excluding your API key. **Delete history** removes those records but keeps settings and the key; use **Clear saved key** separately. The experimental build retains records for up to 180 days. The public Store edition uses a separate encrypted local database and has its own export and deletion controls.

- **No new time or starts:** Keep Chrome frontmost and the video visible, check that tracking is on, and allow at least three seconds of real playback. Refresh tabs that were open before an extension update.
- **No check-in:** Check In-page alerts, Movie Mode, snooze, quiet hours, and site exclusions. After a seek, allow about 15 seconds of continued playback. Some fullscreen players cannot display extension overlays.
- **Gemini API analysis is queued or fails:** Check **Settings → Latest Gemini API analysis**, your consent and key, public video access, connection, and quota. Do not send your key or raw response in a support report.
- **Generic title:** The site may not provide reliable video metadata. Watchwise does not guess a title from unrelated page text.

For help, [open a GitHub issue](https://github.com/amolsharma99/Watchwise/issues) with a public or synthetic example. Do not attach private viewing history or credentials.

<sub>Images above use synthetic data from the older Store demo capture. The current experimental build uses the ink and caramel design; no Gemini result is fabricated here.</sub>
