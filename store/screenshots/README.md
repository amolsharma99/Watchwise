# Local-only Store edition screenshots

Images 01–05 are 640×400 Chrome Web Store candidates. Image 06 appears only in the user guide. They show demonstration data rendered from the v0.4.0 Store edition's own `sidepanel.html` and `sidepanel.css`. Image 03 demonstrates the in-page goal toast over a synthetic video page. No personal history, API key, Gemini result, or third-party video frame was captured.

Run `python3 tools/render_store_demo_screenshots.py` from the repository root to regenerate the HTML fixtures. Render each fixture at 640×400 in an isolated browser profile, then visually compare it with the packaged Store UI before uploading. The screenshots are illustrations of the interface, not proof of a live packaged Chrome installation.
