# Automatic YouTube summaries: feasibility, 18 November 2026

## Decision for the public extension

Do not claim that Watchwise can automatically summarise an arbitrary YouTube video in the current local-only Store release. Keep v0.4.0 and its Store disclosures unchanged. A genuine summary requires the video's spoken/visual content or a transcript. The current public extension deliberately does not read captions or page-body text, and its listing says it has no AI feature.

The most direct technical route is the Gemini API's public YouTube URL input. Google currently describes URL input as a no-charge preview and gives a free-tier limit of eight hours of YouTube video per day. Ten ordinary videos could fit within that **video-duration** limit, but request/model/project quotas are separate and the existing Watchwise test received a quota failure. More importantly, the Gemini API terms describe professional or business development and say it is not for consumer use. That makes it unsuitable to reintroduce into a public personal-use product without clear eligibility guidance. AI Studio in a browser has separate product behavior and does not grant an extension access to its signed-in session. [Video URL documentation](https://ai.google.dev/gemini-api/docs/video-understanding#youtube) · [Gemini API terms](https://ai.google.dev/gemini-api/terms)

## Local AI route

Chrome's built-in Summarizer and Prompt APIs can run locally without a provider API key or per-request fee. They are conditional on Chrome version, supported hardware and disk space, model/task availability, and sometimes a user gesture for first download. The Prompt API does not run in a service worker. Watchwise already has a source-only Nano trial, but the user's Chrome reported the configured model capability unavailable even while `chrome://on-device-internals` showed a ready foundation model. A ready broker is therefore not proof that Watchwise's summarisation task can run. [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api) · [Chrome Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)

Local summarisation still needs a supported content source. YouTube's official transcript UI exists only for videos with captions. Its Data API `captions.download` requires permission to **edit** the video, so it cannot fetch transcripts of arbitrary public videos. YouTube's developer policy disallows scraping YouTube apps or scraped YouTube data, and YouTube's general terms restrict automated access. Do not use undocumented player endpoints or hidden page state as a general transcript source. [YouTube transcripts](https://support.google.com/youtube/answer/15930243) · [Caption download API](https://developers.google.com/youtube/v3/docs/captions/download) · [Developer policy](https://developers.google.com/youtube/terms/developer-policies) · [YouTube terms](https://www.youtube.com/t/terms)

Chrome's Prompt API accepts audio, but audio input requires a GPU. `chrome.tabCapture` requires an explicit extension invocation and records the currently active tab in real time; it cannot quietly preanalyse a video as soon as playback starts. It also adds a sensitive permission and would need an explicit recording consent and revised privacy disclosure. [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) · [Tab capture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)

## Viable next experiment

1. Validate local AI **quality and availability** in an opt-in Labs build using the existing public, bundled sample transcript and a few user-supplied transcripts. Show the model readiness state and whether it actually completes. Treat a transcript-only verdict as a judgment of spoken content, not a fact-check or assessment of unseen visuals.
2. If local AI works reliably, design an explicit transcript-input flow for captioned videos and update consent, privacy policy, Store data-usage disclosures, and version before release. Do not call it automatic until a compliant automatic transcript source is available.
3. For genuinely automatic summaries, seek a supported video-understanding provider and a distribution model whose terms permit this consumer extension; impose one job per canonical standard YouTube video, a user-adjustable daily cap of ten, cancellation, clear per-video status, and quota/cost controls. Exclude Shorts, live streams, previews, private videos, and unidentified URLs. Never present a title/description-based guess as a video summary.

## Test gate before release

- Verify summary quality on useful, low-information, and captionless videos; display `unavailable` rather than inventing content.
- Verify ten starts in a day create at most ten requests and a duplicate/reload creates none.
- Verify AI off, tracking off, Movie Mode, excluded sites, and incognito behavior.
- Verify transcript/audio/video input and any remote destination match the actual Store and privacy disclosures.
