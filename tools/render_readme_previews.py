#!/usr/bin/env python3
"""Draw source-aligned Watchwise README previews as SVG, using sample data.

These are vector interface previews, not browser captures. Labels and the ink and
caramel palette come from the current local-only side-panel source.
"""

from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "readme"
OUTPUT.mkdir(parents=True, exist_ok=True)

INK = "#252420"
CREAM = "#faf9f6"
CANVAS = "#f2efe9"
MUTED = "#6e685f"
BORDER = "#dcd6cb"
SOFT = "#e8e1d7"
ROW = "#f3efe8"
CARAMEL = "#865f3f"
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"


def rect(x, y, width, height, fill, radius=0, stroke=None, stroke_width=1, extra=""):
    border = f' stroke="{stroke}" stroke-width="{stroke_width}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{fill}"{border} {extra}/>'


def text(x, y, value, size=16, color=INK, weight=500, anchor="start", extra=""):
    return (f'<text x="{x}" y="{y}" fill="{color}" font-family="{FONT}" '
            f'font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" {extra}>'
            f'{escape(value)}</text>')


def rule(x1, y1, x2, y2, color=BORDER, width=1):
    return f'<path d="M{x1} {y1}H{x2}" stroke="{color}" stroke-width="{width}"/>' if y1 == y2 else f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{color}" stroke-width="{width}"/>'


def icon(x=451, y=43):
    # The same eye/play geometry as store/icon-ink-caramel/watchwise-eye-play.svg.
    return f'''<g transform="translate({x} {y}) scale(.36)">
      <rect x="16" y="16" width="96" height="96" rx="25" fill="#2d2823"/>
      <path d="M31 64C40.3 49.1 51.8 42 64 42s23.7 7.1 33 22c-9.3 14.9-20.8 22-33 22S40.3 78.9 31 64Z" fill="none" stroke="#F6F1E8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M57.5 52.5c0-1.7 1.9-2.7 3.3-1.8l17.4 11.5c1.3.9 1.3 2.8 0 3.6L60.8 77.3c-1.4.9-3.3-.1-3.3-1.8v-23Z" fill="#D19A62"/>
    </g>'''


def video_page():
    parts = [
        rect(0, 0, 960, 600, "#e7dfd3"),
        rect(25, 25, 376, 550, "#f6f1e9", 22, "#d8cfc2"),
        text(47, 67, "EXAMPLE VIDEO PAGE", 11, CARAMEL, 800, extra='letter-spacing="2"'),
        rect(47, 106, 332, 254, "url(#video)", 16),
        '<circle cx="213" cy="232" r="29" fill="#ffffff35"/>',
        '<path d="M206 218l21 14-21 14Z" fill="#fffaf2"/>',
        rect(65, 336, 296, 4, "#e4d9c9", 2),
        rect(65, 336, 112, 4, "#c6925e", 2),
        rect(47, 385, 252, 11, "#dfd4c5", 5),
        rect(47, 408, 323, 8, "#e8dfd2", 4),
        rect(47, 425, 287, 8, "#e8dfd2", 4),
        text(48, 545, "INTERFACE PREVIEW  •  SAMPLE DATA", 10, "#8f7962", 750, extra='letter-spacing="1.3"'),
    ]
    return "\n".join(parts)


def frame():
    return "\n".join([
        rect(425, 24, 510, 552, CANVAS, 22, BORDER, extra='filter="url(#panel-shadow)"'),
        rect(426, 25, 508, 65, "#eee8dd", 21),
        rect(426, 76, 508, 16, "#eee8dd"),
        rule(426, 90, 934, 90),
        icon(),
        text(497, 58, "Watchwise", 16, INK, 760),
        text(497, 76, "Watch with intent", 11, MUTED, 500),
        text(895, 66, "↻", 26, MUTED, 400, "middle"),
    ])


def tabs(active):
    parts = [rect(447, 109, 465, 44, SOFT, 13)]
    if active == "overview":
        parts.append(rect(450, 112, 228, 38, CREAM, 10))
    else:
        parts.append(rect(681, 112, 228, 38, CREAM, 10))
    parts.append(text(565, 137, "Overview", 13, INK if active == "overview" else MUTED, 700, "middle"))
    parts.append(text(795, 137, "Settings", 13, INK if active == "settings" else MUTED, 700, "middle"))
    return "\n".join(parts)


def overview():
    return "\n".join([
        tabs("overview"),
        text(447, 188, "YOUR ATTENTION", 11, CARAMEL, 800, extra='letter-spacing="1.6"'),
        text(447, 226, "Today", 34, INK, 760),
        rect(815, 201, 98, 27, SOFT, 14),
        '<circle cx="830" cy="214" r="4" fill="#866343"/>',
        text(839, 218, "Tracking on", 10, CARAMEL, 750),
        rect(447, 250, 228, 139, "url(#attention)", 17),
        text(463, 279, "Active watching", 11, "#e9e2d8", 680),
        text(463, 340, "24m", 45, "#fffaf2", 760),
        text(463, 369, "Time spent today", 11, "#e9e2d8", 500),
        '<circle cx="686" cy="388" r="81" fill="none" stroke="#ffffff20" stroke-width="16"/>',
        rect(687, 250, 226, 139, CREAM, 17, BORDER),
        text(703, 279, "Videos started", 11, MUTED, 680),
        text(703, 340, "3", 45, INK, 760),
        text(703, 369, "Played for 3+ seconds", 11, MUTED, 500),
        rect(447, 402, 466, 76, CREAM, 17, BORDER),
        text(463, 434, "This week", 13, INK, 700),
        text(896, 434, "2h 14m", 20, INK, 750, "end"),
        text(463, 457, "12 starts", 11, MUTED),
        rect(447, 490, 466, 145, CREAM, 17, BORDER),
        text(463, 523, "Top sites", 15, INK, 750),
        text(895, 523, "Today", 11, MUTED, 500, "end"),
        text(463, 553, "youtube.com", 12, INK, 650),
        text(895, 553, "16m", 12, INK, 650, "end"),
    ])


def breakdown():
    return "\n".join([
        rect(447, 113, 466, 177, CREAM, 17, BORDER),
        text(464, 146, "Top sites", 15, INK, 750),
        text(896, 146, "Today", 11, MUTED, 500, "end"),
        text(464, 179, "youtube.com", 12, INK, 680),
        text(896, 179, "16m", 12, INK, 650, "end"),
        rect(464, 189, 432, 5, SOFT, 3),
        rect(464, 189, 432, 5, CARAMEL, 3),
        text(464, 222, "netflix.com", 12, INK, 680),
        text(896, 222, "8m", 12, INK, 650, "end"),
        rect(464, 232, 432, 5, SOFT, 3),
        rect(464, 232, 216, 5, "#c29160", 3),
        rect(447, 302, 466, 357, CREAM, 17, BORDER),
        text(464, 335, "Video breakdown", 15, INK, 750),
        rect(799, 315, 97, 30, SOFT, 9),
        rect(802, 318, 43, 24, CREAM, 7),
        text(823, 334, "Today", 10, CARAMEL, 700, "middle"),
        text(870, 334, "Week", 10, MUTED, 600, "middle"),
        text(464, 366, "▸  How time is counted", 11, CARAMEL, 650),
        rect(464, 384, 432, 72, ROW, 12, BORDER),
        text(477, 408, "Example public video", 13, INK, 700),
        text(882, 408, "12m", 12, CARAMEL, 750, "end"),
        text(477, 439, "youtube.com", 11, MUTED),
        text(577, 439, "Open video", 11, CARAMEL, 700),
        rect(464, 466, 432, 72, ROW, 12, BORDER),
        text(477, 490, "Example documentary episode", 13, INK, 700),
        text(882, 490, "8m", 12, CARAMEL, 750, "end"),
        text(477, 521, "netflix.com", 11, MUTED),
        text(569, 521, "Open video", 11, CARAMEL, 700),
    ])


def toggle(x, y, enabled):
    return "\n".join([
        rect(x, y, 39, 23, CARAMEL if enabled else "#d9d2c8", 12),
        f'<circle cx="{x + (27 if enabled else 12)}" cy="{y + 11.5}" r="8.5" fill="white"/>'
    ])


def controls():
    return "\n".join([
        tabs("settings"),
        text(447, 188, "YOUR CONTROLS", 11, CARAMEL, 800, extra='letter-spacing="1.6"'),
        text(447, 226, "Settings", 34, INK, 760),
        rect(447, 246, 466, 117, CREAM, 17, BORDER),
        text(464, 276, "Track visible videos", 13, INK, 700),
        text(464, 293, "Off by default; local history only", 11, MUTED),
        toggle(854, 262, True),
        rule(464, 307, 896, 307, "#e9e2d8"),
        text(464, 331, "In-page alerts", 13, INK, 700),
        text(464, 348, "Brief local nudges in video tabs", 11, MUTED),
        toggle(854, 317, True),
        rect(447, 376, 466, 288, CREAM, 17, BORDER),
        text(464, 407, "Interruption controls", 15, INK, 750),
        text(464, 442, "Daily viewing target", 12, INK, 680),
        text(464, 461, "60 minutes", 11, MUTED),
        rect(464, 477, 432, 5, SOFT, 3),
        rect(464, 477, 98, 5, CARAMEL, 3),
        '<circle cx="562" cy="479.5" r="8" fill="#ae8055"/>',
        rect(464, 503, 210, 37, CREAM, 10, BORDER),
        rect(686, 503, 210, 37, CREAM, 10, BORDER),
        text(569, 527, "Movie Mode · 2h", 12, INK, 680, "middle"),
        text(791, 527, "Snooze · 30m", 12, INK, 680, "middle"),
        text(464, 565, "Quiet from", 11, MUTED, 650),
        text(686, 565, "Until", 11, MUTED, 650),
    ])


def data():
    return "\n".join([
        rect(447, 113, 466, 158, CREAM, 17, BORDER),
        text(464, 146, "Excluded sites", 15, INK, 750),
        rect(464, 171, 346, 44, CREAM, 10, BORDER),
        text(479, 198, "example.com", 12, MUTED),
        rect(821, 171, 75, 44, CREAM, 10, BORDER),
        text(858, 199, "Add", 12, INK, 700, "middle"),
        rect(447, 285, 466, 241, CREAM, 17, "#d3b7a6"),
        text(464, 320, "Your data", 15, INK, 750),
        text(464, 355, "Local records are encrypted. Export creates plaintext", 12, MUTED),
        text(464, 375, "JSON; store that file safely. You can also", 12, MUTED),
        text(464, 395, "permanently delete local history.", 12, MUTED),
        rect(464, 447, 210, 42, CREAM, 10, BORDER),
        rect(686, 447, 210, 42, "#f1e7e0", 10),
        text(569, 473, "Export JSON", 12, INK, 700, "middle"),
        text(791, 473, "Delete history", 12, "#9f4d41", 700, "middle"),
    ])


def render(filename, scene):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600" role="img" aria-label="Watchwise ink and caramel interface preview with sample data">
      <defs>
        <linearGradient id="video" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3b3832"/><stop offset="1" stop-color="#171614"/></linearGradient>
        <linearGradient id="attention" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#252420"/><stop offset="1" stop-color="#38332d"/></linearGradient>
        <filter id="panel-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="-8" dy="12" stdDeviation="14" flood-color="#46382b" flood-opacity=".13"/></filter>
        <clipPath id="panel-clip"><rect x="426" y="25" width="508" height="550" rx="21"/></clipPath>
      </defs>
      {video_page()}
      {frame()}
      <g clip-path="url(#panel-clip)">{scene()}</g>
    </svg>'''
    path = OUTPUT / filename
    path.write_text(svg + "\n")
    print(path.relative_to(ROOT))


render("overview-ink-caramel.svg", overview)
render("breakdown-ink-caramel.svg", breakdown)
render("controls-ink-caramel.svg", controls)
render("data-ink-caramel.svg", data)
