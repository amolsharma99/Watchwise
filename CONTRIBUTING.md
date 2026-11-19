# Contributing to Watchwise

Watchwise is for people who want to watch with more intention. Reports from real viewing habits, clearer wording, accessibility fixes, and careful code changes are welcome.

## Start with the problem

- [Suggest a feature](https://github.com/amolsharma99/Watchwise/issues/new?template=feature_request.yml) when a website, insight, control, or nudge could help you use your time better.
- [Report a bug](https://github.com/amolsharma99/Watchwise/issues/new?template=bug_report.yml) when tracking, the side panel, or an in-page action behaves unexpectedly.
- For a larger code change, open an issue first so we can agree on the behavior and which build it belongs in. Small fixes can go straight to a pull request.

Describe what happened, what you expected, and a **public or synthetic** example if one helps. Remove private viewing history, personal video links, account details, cookies, API keys, and tokens from issues, logs, screenshots, and commits. We cannot troubleshoot with a private key.

## Choose the right build

| Build | Source | Scope |
| --- | --- | --- |
| Submitted Store package | Release ZIP described in [`store/USER_GUIDE.md`](store/USER_GUIDE.md) | Local tracking and nudges; no AI Studio shortcut or Gemini API |
| Current local-only source | [`ChromeExtension/store-local`](ChromeExtension/store-local) | Local tracking, insights, and nudges; not yet uploaded |
| Experimental unpacked build | [`ChromeExtension`](ChromeExtension) | Local features and optional Gemini API analysis |

The older Swift Mac app and browser bridge are legacy source. New Chrome-extension work generally belongs in one of the two `ChromeExtension` folders above. If a shared behavior changes, check both editions and keep the submitted Store disclosures accurate until a new package is released.

## Send a focused pull request

1. Explain the user-facing change and link its issue if there is one.
2. Keep the interface simple and make consent, quota, and data-handling behavior clear where a user makes a choice.
3. Add a meaningful test for a bug or behavior change. On macOS, run the relevant commands from the [README's verification section](README.md#build-and-verify). Check the side panel in a narrow window and test in-page behavior on a real video page when the change affects UI.
4. Update the README, user guide, privacy text, or screenshots when users would otherwise see an inaccurate claim. Label synthetic screenshots as demonstrations; never use a person's viewing history or a fabricated AI result.

Please keep reports and reviews kind and specific. The most useful question is whether the change helps someone notice, understand, or reduce unintentional watching.
