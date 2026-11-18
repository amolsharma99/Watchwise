"""Render the source eye/play shape as deterministic 8-bit RGBA PNG icons.

The rasterizer uses only Python's standard library so packaging needs no font,
graphics library or network dependency. The editable vector is
store-local/assets/icon.svg.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "store-local" / "assets"


def cubic(p0, p1, p2, p3, t):
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
    )


CURVES = [
    ((31, 64), (40.3, 49.1), (51.8, 42), (64, 42)),
    ((64, 42), (76.2, 42), (87.7, 49.1), (97, 64)),
    ((97, 64), (87.7, 78.9), (76.2, 86), (64, 86)),
    ((64, 86), (51.8, 86), (40.3, 78.9), (31, 64)),
]
EYE = [cubic(*curve, step / 20) for curve in CURVES for step in range(20)]
EYE.append(EYE[0])
PLAY = ((57.5, 51), (79.5, 64), (57.5, 77))


def segment_distance_sq(x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
    return (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2


def in_triangle(x, y, points=PLAY):
    signs = []
    for a, b in zip(points, points[1:] + points[:1]):
        signs.append((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]))
    return all(value >= 0 for value in signs) or all(value <= 0 for value in signs)


def in_rounded_square(x, y):
    if not (16 <= x <= 112 and 16 <= y <= 112):
        return False
    cx = min(max(x, 41), 87)
    cy = min(max(y, 41), 87)
    return (x - cx) ** 2 + (y - cy) ** 2 <= 25**2


def rgba_at(x, y):
    if not in_rounded_square(x, y):
        return (0, 0, 0, 0)
    if in_triangle(x, y):
        return (209, 154, 98, 255)
    if min(segment_distance_sq(x, y, a, b) for a, b in zip(EYE, EYE[1:])) <= 3.5**2:
        return (246, 241, 232, 255)
    t = max(0.0, min(1.0, (x + y - 32) / 192))
    return tuple(round(start * (1 - t) + end * t) for start, end in zip((59, 52, 45), (33, 30, 27))) + (255,)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def render(size):
    sample = 4
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            sums = [0, 0, 0, 0]
            for sy in range(sample):
                for sx in range(sample):
                    x = (px + (sx + 0.5) / sample) * 128 / size
                    y = (py + (sy + 0.5) / sample) * 128 / size
                    r, g, b, a = rgba_at(x, y)
                    for index, value in enumerate((r, g, b, a)):
                        sums[index] += value
            rows.extend(round(value / (sample * sample)) for value in sums)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")
    (OUT / f"icon{size}.png").write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for dimension in (16, 32, 48, 128):
        render(dimension)
