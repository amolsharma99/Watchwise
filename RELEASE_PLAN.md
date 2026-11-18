# Chrome Web Store release plan

Updated 18 November 2026. This is the working release record, not a claim that Watchwise is already listed.

## Store requirements

Google requires a registered Chrome Web Store developer account, a one-time registration fee, 2-Step Verification, a ZIP with `manifest.json` at its root, a store icon, at least one 1280×800 or 640×400 screenshot, accurate listing and privacy declarations, and a public privacy-policy URL when user data is handled. The dashboard then accepts a submission for review. Public visibility makes the approved item discoverable and installable; review can take time. See Google's [registration](https://developer.chrome.com/docs/webstore/register), [image](https://developer.chrome.com/docs/webstore/images), [publishing](https://developer.chrome.com/docs/webstore/publish), and [user-data policy](https://developer.chrome.com/docs/webstore/program-policies/policies) documentation.

## Current decision gate

The tested v0.3.9 package includes optional Gemini analysis, but Google's [Gemini API Additional Terms](https://aistudio.google.com/docs/terms) introduce unresolved conditions for a public consumer-facing API client: professional/business use, under-18 access, available regions, and paid-service use for end users in the EEA, Switzerland and UK. A user-supplied API key alone does not establish those conditions. **Do not upload the v0.3.9 AI-enabled ZIP as a public item.**

The owner chose to publish a v0.4.0 local-only Store edition with video tracking, insights, in-page nudges, Movie Mode and privacy controls. It has no Gemini API calls or AI/key controls. The full AI-enabled build remains a separate experimental source build pending policy resolution. The owner confirmed that the older AI-enabled ZIP has not been uploaded to the Chrome Web Store.

The first Store installation will have a different Chrome extension ID and a clean local-only database, so its history will start fresh. Watchwise has Export JSON but no import. Export the unpacked build's history first if those old records matter, clear its saved Gemini key if you no longer use it, then **disable the unpacked extension** before using the Store edition so two copies do not show duplicate nudges. You may leave the disabled unpacked copy installed temporarily to retain its separate history. There is no automatic transfer between them.

## Work status

- [x] Audit Chrome Web Store and Gemini publication rules.
- [x] Produce a privacy policy, user guide and listing draft for the current full build.
- [x] Render demonstration screenshots from Watchwise's interface with no personal viewing data or key.
- [x] Run source, integration, security, package, and deterministic ZIP checks on the full v0.3.9 build.
- [x] Finalize and test the AI-free v0.4.0 Store edition; manager and security reviewer approved ZIP SHA-256 `fd43dbc309170f7dee0c9b9b4fedc0221465752897df6c5a3f526c6c3e6a2044`.
- [x] Encrypt local viewing records at rest and verify insights, export, pruning, deletion, and secure reset in real Chrome.
- [x] Align its privacy policy, guide, listing, and screenshots with the packaged UI.
- [ ] Publish the matching privacy-policy URL and documentation in the public GitHub repository.
- [ ] Test the final packaged build in Chrome, including install/update, a fresh video, start/time count, goal toast, Movie Mode, export, and deletion.
- [ ] Complete developer registration and 2-Step Verification in the owner's Google account, if needed.
- [ ] Upload the final ZIP and screenshots; complete Store Listing, Privacy, Distribution, and reviewer test instructions.
- [ ] Submit for review with Public visibility if the owner chooses to release. Record the item ID and listing URL after submission/approval.

## Account and dashboard handoff

The [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/) currently requires the owner's Google re-verification. The available browser automation surface reports that the extensions gallery cannot be scripted, so the account registration and final dashboard submission must be completed by the owner in Chrome. Do not share a password, verification code, or API key. The release ZIP, text fields, screenshots, and privacy URL are prepared locally for copy/upload.
