# Security and privacy model

The planned public product is the local-only `ChromeExtension/store-local/` Manifest V3 edition. Its [privacy policy](store/PRIVACY.md) describes the Store package. The root `ChromeExtension/` build is experimental and includes Gemini; it must not be uploaded as the public Store edition while its API eligibility remains unresolved. The older Swift app and browser bridge in this repository are legacy source and are not packaged for Chrome Web Store distribution.

- The Store edition has no account, AI service, API key, developer server, or analytics. Tracking starts only after consent. It reads supported HTML5 playback and narrow title metadata, without collecting pixels, audio, captions, cookies, forms, credentials, or arbitrary page text.
- Eligible titles, canonical HTTPS URLs, playback events, and settings are encrypted with AES-256-GCM in local IndexedDB. A non-extractable key is stored in the same Chrome profile. This protects the data at rest but does not protect against someone with access to an unlocked profile. An explicit JSON export is unencrypted; users should keep it private.
- Delete history clears viewing records; the Store edition automatically prunes old playback events after 180 days. Tracking off stops new collection without erasing previous records.

## Experimental Gemini build

- Tracking and Gemini consent are separate and off by default. The content script sees only supported HTML5 video playback and narrow title metadata. It does not collect pixels, audio, captions, cookies, forms, credentials, or arbitrary page text.
- The extension records eligible video titles, canonical HTTPS URLs, sites, timestamps, position, duration, speed, and playback state in local IndexedDB. It does not send this history to a Watchwise server.
- The optional Gemini API key is saved in `chrome.storage.local` with trusted-context access. The key is never returned to content scripts, placed in URLs, included in exports, or logged by Watchwise. Chrome profile storage is not a system Keychain.
- Gemini requests send only the selected public YouTube URL, an analysis prompt, and the user's key directly to Google's API. The API request stores its interaction remotely for asynchronous polling. See [PRIVACY.md](PRIVACY.md) for the user-facing disclosure.
- Remote analysis accepts only canonical public HTTPS YouTube URLs. Localhost, private-network hosts, file URLs, embedded credentials, and excluded sites are rejected.
- Gemini value assessments are advisory. Results include a confidence score, supporting signals, and a reminder that no external fact-checking was performed.
- Explicit Export JSON omits the API key. Delete history clears local viewing and analysis records, while Clear saved key removes the key separately.

## Reporting a problem

Do not include viewing history, URLs, API keys, or database files in a bug report. Use a public or synthetic reproduction instead.
