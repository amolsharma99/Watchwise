# README interface previews

These SVGs show the current Watchwise ink and caramel interface with synthetic viewing data. The side-panel previews follow `ChromeExtension/store-local/sidepanel.html` and `sidepanel.css`. The nudge preview uses message copy from `ChromeExtension/lib/goal-checkin.js` and toast styling from the content script. They are vector previews, not captures from a Chrome profile or evidence that a particular video was watched.

Regenerate the side-panel previews with `python3 tools/render_readme_previews.py` from the repository root. Review all previews against the extension UI whenever the UI changes.
