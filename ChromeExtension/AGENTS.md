# Watchwise product and UX direction

Watchwise helps people notice and reduce passive video watching. Design choices should support that goal, not reward more consumption.

- Keep the overview focused on time spent, meaningful video starts, and the videos that used the most time. Rank video rows by watched time and show a useful title and link when available.
- Do not restore the removed “Content covered” or completion-count metrics. Avoid new vanity metrics unless the user asks for them and they clearly support intentional viewing.
- Make the next useful action obvious. Keep Movie Mode and notification controls easy to find. The side panel has only Overview and Settings. Do not restore the redundant AI Studio summary handoff on YouTube; YouTube offers its own Ask action. Keep optional automatic Gemini API controls and a collapsed latest result in Settings, without restoring a separate Analyse tab or manual API form.
- Use plain language and short labels. Explain costs, privacy, and limits where a person makes the relevant choice, without filling the overview with technical details.
- Keep tracking and AI consent explicit. Do not infer a video title from unrelated page body text or present an uncertain title as fact.
- In-page nudges offer **This is work** to exclude the top-level website from future tracking and nudges. Keep that action visible and reversible in Settings; do not erase existing history on exclusion.
- Before shipping a UX change, check the side panel at narrow width, empty and populated states, today/week switching, and that the visible dashboard matches the extension’s current version.

These principles are specific to Watchwise. Follow higher-priority user instructions for any future change.
