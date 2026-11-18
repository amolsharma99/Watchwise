# Draft Store update disclosure for Watchwise 0.4.1

This is preparation for a future update. The v0.4.0 Store submission, listing and published privacy policy remain unchanged while under review.

## Listing feature line

“On standard YouTube watch pages, an optional Ask in AI Studio button copies the public video link and a prepared prompt, then opens Google AI Studio. You paste and submit it yourself. Watchwise does not receive the answer or call an AI service.”

## Privacy-policy addition

“The Ask in AI Studio button appears on standard YouTube watch pages even when local tracking is off. It reads the page URL only to identify the public video ID. It does not read captions, audio, pixels, page text, cookies, or a Google account. When you click the button, Watchwise copies a prompt containing the canonical public YouTube URL to your clipboard and opens Google AI Studio in a new tab. Watchwise itself does not transmit the URL or prompt to Google, read your Studio session, or collect the generated answer. You decide whether to paste and send the prompt in Studio. Google’s own terms and privacy practices apply to your use of Studio.”

## Reviewer instructions

1. Open a standard public `https://www.youtube.com/watch?v=...` page. The action near YouTube's watch-page controls reads “Ask in AI Studio”.
2. Click it. A new AI Studio tab opens after Watchwise copies a prompt to the clipboard. Paste into Studio; no automatic submission occurs.
3. Navigate to another watch page within YouTube; one action remains. Navigate to a Short or feed; the action disappears. Enter fullscreen on a watch page; it disappears until fullscreen ends.
4. Disable Watchwise tracking and repeat step 1: the optional handoff still appears, but no playback history is saved.

Before uploading the update, publish the matching privacy-policy text and refresh Store screenshots if the changed icon/palette is visible. Review the Store data-use declaration for consistency. The Studio-specific call to action also needs eligibility guidance under Google's AI Studio terms; otherwise use a provider-neutral action in the public build. This draft does not itself authorize submitting the new ZIP while v0.4.0 review is pending.
