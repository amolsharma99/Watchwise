#!/usr/bin/env python3
"""Build local-only Store edition screenshot fixtures from its real HTML/CSS.

These fixtures contain only synthetic viewing data. Chrome Web Store images are
01-05; 06 is a guide-only close-up of export/delete controls.
"""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "ChromeExtension"
STORE = ROOT / "store"
FIXTURES = STORE / "screenshot-fixtures"
IMAGES = STORE / "screenshots"
FIXTURES.mkdir(parents=True, exist_ok=True)
IMAGES.mkdir(parents=True, exist_ok=True)

html = (EXTENSION / "store-local" / "sidepanel.html").read_text()
html = "\n".join(line.rstrip() for line in html.splitlines()) + "\n"
css = (EXTENSION / "store-local" / "sidepanel.css").read_text()
frame_css = """<style>
html { background: #e8e6f2; }
html::before { content: 'DEMO VIDEO PAGE'; position: fixed; top: 42px; left: 18px;
  width: 172px; height: 260px; border-radius: 16px; display: grid; place-items: center;
  color: #7b7295; font: 700 11px system-ui; letter-spacing: .1em;
  background: linear-gradient(140deg, #d9d5e8, #f7f5fb); box-shadow: 0 8px 30px #625a7d22; }
body { width: 420px; min-width: 420px; margin-left: 220px; min-height: 800px;
  box-shadow: -10px 0 34px #625a7d24; }
</style>"""
html = html.replace('<link rel="stylesheet" href="sidepanel.css">', f"<style>{css}</style>{frame_css}")
html = html.replace('  <script type="module" src="sidepanel.js"></script>\n', "")

base = """
const $ = (id) => document.getElementById(id);
$('app').hidden = false; $('onboarding').hidden = true;
$('buildVersion').textContent = 'Watch with intent · v0.4.0';
$('trackingPill').textContent = 'Tracking on'; $('trackingPill').classList.remove('off');
$('trackingEnabled').checked = true; $('notificationsEnabled').checked = true;
$('todayTime').textContent = '24m'; $('todayStarted').textContent = '3';
$('weekTime').textContent = '2h 14m'; $('weekVideos').textContent = '12 starts';
$('sites').innerHTML = `
  <div class="site-row"><strong>youtube.com</strong><span>16m</span><div class="bar"><i style="width:100%"></i></div></div>
  <div class="site-row"><strong>netflix.com</strong><span>8m</span><div class="bar"><i style="width:50%"></i></div></div>`;
$('videoBreakdown').innerHTML = `
  <div class="video-row"><strong>Example public video</strong><time>12m</time><div class="video-meta"><span>youtube.com</span><a href="https://www.youtube.com/watch?v=9hE5-98ZeCg">Open video</a></div></div>
  <div class="video-row"><strong>Example documentary episode</strong><time>8m</time><div class="video-meta"><span>netflix.com</span><a href="https://www.netflix.com/watch/12345678">Open video</a></div></div>
  <div class="video-row"><strong>Short video example</strong><time>4m</time><div class="video-meta"><span>youtube.com</span><a href="https://www.youtube.com/shorts/9hE5-98ZeCg">Open video</a></div></div>`;
"""

scenes = {
    "01-overview": "window.scrollTo(0, 0);",
    "02-breakdown": """
      document.querySelector('.tabs').remove();
      document.querySelector('.section-heading').remove();
      document.querySelector('.metric-grid').remove();
      document.querySelector('.week-summary').remove();
      window.scrollTo(0, 0);
    """,
    "04-settings": """
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === 'settings'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'settings'));
      window.scrollTo(0, 0);
    """,
    "05-interruption-controls": """
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'settings'));
      document.querySelector('.tabs').remove();
      document.querySelector('#settings > .eyebrow').remove();
      document.querySelector('#settings > h1').remove();
      document.querySelector('#settings > .settings-group').remove();
      window.scrollTo(0, 0);
    """,
    "06-your-data": """
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'settings'));
      document.querySelector('.tabs').remove();
      document.querySelector('#settings > .eyebrow').remove();
      document.querySelector('#settings > h1').remove();
      document.querySelectorAll('#settings > .settings-group').forEach((group) => {
        if (!group.classList.contains('danger-zone') && !group.textContent.includes('Excluded sites')) group.remove();
      });
      window.scrollTo(0, 0);
    """,
}

for name, scene in scenes.items():
    (FIXTURES / f"{name}.html").write_text(html.replace("</body>", f"<script>{base}{scene}</script></body>"))

shutil.copyfile(ROOT / "docs/screenshot-fixtures/03-goal-checkin.html", FIXTURES / "03-goal-checkin.html")
print(f"Wrote {len(scenes) + 1} Store-edition fixtures to {FIXTURES}")
