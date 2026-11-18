# Watchwise next-release candidate

Updated 18 November 2026. These working-tree changes are for a future Store update. The submitted local-only v0.4.0 ZIP remains unchanged while Google reviews it.

## Ready for visual acceptance

- A focused violet active-watching card, calmer supporting cards and video rows, refined tabs and switches, and light/dark and reduced-motion styles. The overview order and controls are unchanged.
- The 15-second goal check-in now selects a stable message for each video using safe context: a tutorial-style title category, a recent multi-video streak, or a streaming site. It never puts the raw title in the toast. Daily-target and longer-session copy can mention aggregate watched minutes.
- Existing one-per-video processing, anti-spam gap, consent, Movie Mode, snooze, quiet hours and site exclusions remain in force.

Engineering review found no blocker. Automated verification passed: 54 JavaScript module tests, goal-delivery orchestration, integration and local Store contracts, package validation, and isolated Chrome WebCrypto/IndexedDB checks. The submitted ZIP's SHA-256 remains `fd43dbc309170f7dee0c9b9b4fedc0221465752897df6c5a3f526c6c3e6a2044`.

Before a future Store update, inspect the side panel in narrow light and dark modes, including empty and populated states, then give the update a new version and build a new ZIP. Do not upload working-tree files as the already submitted v0.4.0 package.

## Automatic YouTube summaries

[Feasibility and source links](AUTO_SUMMARY_FEASIBILITY.md). This is research, not a released feature. Current Chrome local AI needs usable transcript or audio input; the public YouTube API does not provide arbitrary videos' transcripts, and scraping is prohibited. Gemini's public YouTube URL input is a no-charge preview, but model quota and its consumer-use terms remain separate barriers for a public Watchwise extension. The next honest experiment is an opt-in local-AI quality trial with user-supplied transcripts, followed by a supported source/provider decision.
