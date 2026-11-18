# Watchwise next-release candidate

Updated 19 November 2026. These working-tree changes are the v0.4.1 candidate for a future Store update. The submitted local-only v0.4.0 ZIP remains unchanged while Google reviews it.

Local candidate package: `ChromeExtension/dist/watchwise-local-v0.4.1-candidate.zip` (SHA-256 `a5f0471c25ec62795fd85bbe06c14d4e9bf4334e8b1e5e28fc1a8e583301dd93`). The matching unpacked test tree is `ChromeExtension/dist/watchwise-local-v0.4.1-unpacked`. Neither has been uploaded.

The v0.4.1 ZIP and unpacked test tree are now superseded for testing and upload. Their Studio button opens the site root, which can redirect a signed-in user to Usage instead of a new chat. The working source now targets `/prompts/new_chat`; build and review a newly versioned candidate before any Store upload. The original unpacked development installation received this fix as v0.3.11.

## Ready for visual acceptance

- The owner selected **Ink & caramel**: a warm bone canvas, near-black active-watching card, restrained caramel accents, and clean Mac system typography. The W mark is replaced with the eye/play icon in the extension and its panels. The overview order and controls are unchanged.
- The 15-second goal check-in now selects a stable message for each video using safe context: a tutorial-style title category, a recent multi-video streak, or a streaming site. It never puts the raw title in the toast. Daily-target and longer-session messages focus on the user's choice and give a warm invitation to leave; the copy does not repeat minute counts. Toast copy uses at most one emoji.
- Existing one-per-video processing, anti-spam gap, consent, Movie Mode, snooze, quiet hours and site exclusions remain in force.

Automated verification passed: 54 JavaScript module tests, goal-delivery orchestration, integration and local Store contracts, package validation, and isolated Chrome WebCrypto/IndexedDB checks. The submitted ZIP's SHA-256 remains `fd43dbc309170f7dee0c9b9b4fedc0221465752897df6c5a3f526c6c3e6a2044`. Engineering review identified Store disclosure and AI Studio terms as release gates; this candidate is not approved for a public upload.

- A small “Ask in AI Studio” action appears beside YouTube's watch-page actions, including after YouTube in-page navigation. It stays off Shorts, feeds, embeds and fullscreen video. A temporary upper-right placement covers the brief period before YouTube renders its action row. The button is available even when viewing-history tracking is off. On click, it copies only the canonical public video URL and a prepared prompt, then opens AI Studio for the user to paste and send. A manual-copy fallback appears if the clipboard is blocked. Watchwise does not call a model or read the Google account or answer.

Before a future Store update, inspect the side panel in narrow light and dark modes, including empty and populated states. Smoke-test the button on a standard YouTube watch page, another watch page reached by in-page navigation, a Short, and fullscreen, then verify clipboard paste in AI Studio. The public privacy-policy URL, guide, listing and screenshots must be updated to match, without changing the live v0.4.0 policy during its review. Google AI Studio's consumer-use terms need written eligibility guidance or the public update must use a provider-neutral copy action. Do not upload this candidate as the already submitted v0.4.0 package.

## Automatic YouTube summaries

[Feasibility and source links](AUTO_SUMMARY_FEASIBILITY.md). Automatic summaries remain research, not a released feature. Current Chrome local AI needs usable transcript or audio input; the public YouTube API does not provide arbitrary videos' transcripts, and scraping is prohibited. Gemini's public YouTube URL input is a no-charge preview, but model quota and its consumer-use terms remain separate barriers for a public Watchwise extension. The AI Studio handoff is user-initiated and does not automate Studio or import its answer.
