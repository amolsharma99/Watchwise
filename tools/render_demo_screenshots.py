#!/usr/bin/env python3
"""Generate truthful, synthetic-data HTML fixtures from the shipped side-panel UI.

The fixtures use the extension's own sidepanel.html and sidepanel.css. They do not
load a user's Chrome profile, history, API key, or a third-party video page.
Render the generated HTML with headless Chrome at 640x400 (see docs/screenshots/README.md).
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "ChromeExtension"
FIXTURES = ROOT / "docs" / "screenshot-fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)

html = (EXTENSION / "sidepanel.html").read_text()
css = (EXTENSION / "sidepanel.css").read_text()
frame_css = """
<style>
html { background: #e8e6f2; }
html::before { content: 'DEMO VIDEO PAGE'; position: fixed; top: 42px; left: 18px;
  width: 172px; height: 260px; border-radius: 16px; display: grid; place-items: center;
  color: #7b7295; font: 700 11px system-ui; letter-spacing: .1em;
  background: linear-gradient(140deg, #d9d5e8, #f7f5fb); box-shadow: 0 8px 30px #625a7d22; }
body { width: 420px; min-width: 420px; margin-left: 220px; min-height: 800px;
  box-shadow: -10px 0 34px #625a7d24; }
</style>
"""
html = html.replace('<link rel="stylesheet" href="sidepanel.css">', f"<style>{css}</style>{frame_css}")
html = html.replace('<script type="module" src="sidepanel.js"></script>', "")

base_script = """
const $ = (id) => document.getElementById(id);
$('app').hidden = false;
$('onboarding').hidden = true;
$('buildVersion').textContent = 'Watch with intent · v0.3.9';
$('trackingPill').textContent = 'Tracking on';
$('trackingPill').classList.remove('off');
for (const id of ['trackingEnabled', 'notificationsEnabled']) $(id).checked = true;
$('todayTime').textContent = '24m';
$('todayStarted').textContent = '3';
$('weekTime').textContent = '2h 14m';
$('weekVideos').textContent = '12 starts';
$('sites').innerHTML = `
  <div class="site-row"><strong>youtube.com</strong><span>16m</span><div class="bar"><i style="width:100%"></i></div></div>
  <div class="site-row"><strong>netflix.com</strong><span>8m</span><div class="bar"><i style="width:50%"></i></div></div>`;
$('videoBreakdown').innerHTML = `
  <div class="video-row"><strong>How to plan a focused workday</strong><time>12m</time><div class="video-meta"><span>youtube.com</span><a href="https://www.youtube.com/watch?v=9hE5-98ZeCg">Open video</a></div></div>
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
    "04-analyse": """
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === 'analyse'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'analyse'));
      $('analysisURL').value = 'https://www.youtube.com/watch?v=9hE5-98ZeCg';
      $('analysisStatus').textContent = 'Optional Gemini analysis uses your key and may use paid API quota.';
      window.scrollTo(0, 0);
    """,
    "05-settings": """
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === 'settings'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'settings'));
      window.scrollTo(0, 0);
    """,
    "06-interruption-controls": """
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'settings'));
      document.querySelector('.tabs').remove();
      document.querySelector('#settings > .eyebrow').remove();
      document.querySelector('#settings > h1').remove();
      document.querySelector('#settings > .settings-group').remove();
      window.scrollTo(0, 0);
    """,
}

for name, scene in scenes.items():
    fixture = html.replace("</body>", f"<script>{base_script}{scene}</script></body>")
    (FIXTURES / f"{name}.html").write_text(fixture)

goal = """<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#131722;color:white;font-family:system-ui}
.page{height:400px;background:linear-gradient(125deg,#232a3c,#171b2b 54%,#302743);position:relative}
.demo{position:absolute;left:24px;top:22px;font-size:11px;letter-spacing:.12em;color:#b7b4c4;font-weight:700}
.video{position:absolute;left:28px;top:68px;width:584px;height:270px;border-radius:14px;background:linear-gradient(140deg,#252b43,#171d2c 60%,#51436b);box-shadow:0 20px 50px #0005}
.play{position:absolute;left:48%;top:42%;width:52px;height:52px;border-radius:50%;background:#ffffff36;display:grid;place-items:center;font-size:20px}
.bar{position:absolute;left:18px;right:18px;bottom:20px;height:5px;border-radius:6px;background:#ffffff40}.bar::before{content:'';display:block;width:24%;height:100%;border-radius:6px;background:#b6a7ff}
#watchwise-toast-host{all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;pointer-events:none}
.toast{box-sizing:border-box;width:340px;padding:14px 15px;border:1px solid rgba(255,255,255,.28);border-radius:16px;background:rgba(22,25,35,.84);box-shadow:0 14px 48px rgba(0,0,0,.32);backdrop-filter:blur(18px);color:#f8fafc;font:500 14px/1.45 system-ui,-apple-system,sans-serif;pointer-events:auto}
.brand{color:#c4b5fd;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.message{margin:5px 0 11px}.actions{display:flex;gap:8px;justify-content:flex-end}button{border:0;border-radius:9px;padding:7px 10px;font:600 12px system-ui;cursor:pointer}button.quiet{background:rgba(255,255,255,.10);color:#f8fafc}
</style></head><body><div class="page"><div class="demo">DEMONSTRATION VIDEO PAGE</div><div class="video"><div class="play">▶</div><div class="bar"></div></div></div>
<div id="watchwise-toast-host"><section class="toast" role="status"><div class="brand">Watchwise</div><div class="message">Hope you’re clear on your goal for watching this video.</div><div class="actions"><button class="quiet">Dismiss</button></div></section></div>
</body></html>"""
(FIXTURES / "03-goal-checkin.html").write_text(goal)

print(f"Wrote {len(scenes) + 1} fixtures to {FIXTURES}")
