"""Génère les icônes PNG de la PWA — style « écran radar » :
fond navy uni, anneaux concentriques, invader blanc avec une très légère brillance.

Python pur (zlib + struct), aucune lib d'image. Usage : python scripts/gen_icons.py
"""
import struct, zlib, os, math

SPRITE = [
    "..X.....X..",
    "...X...X...",
    "..XXXXXXX..",
    ".XX.XXX.XX.",
    "XXXXXXXXXXX",
    "X.XXXXXXX.X",
    "X.X.....X.X",
    "...XX.XX...",
]

NAVY = (0x0B, 0x1D, 0x3A)    # fond navy plein (pas de dégradé)


def png(width, height, rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def make_icon(size):
    gw, gh = len(SPRITE[0]), len(SPRITE)
    px = max(1, int(size * 0.46 / gw))
    ox = (size - gw * px) // 2
    oy = (size - gh * px) // 2
    cx = cy = size / 2

    # masque sprite + halo (carte de distance au pixel allumé le plus proche)
    lit = [(ox + (x + 0.5) * px, oy + (y + 0.5) * px)
           for y in range(gh) for x in range(gw) if SPRITE[y][x] == "X"]

    def sprite_hit(x, y):
        gx, gy = int((x - ox) // px), int((y - oy) // px)
        return 0 <= gx < gw and 0 <= gy < gh and SPRITE[gy][gx] == "X"

    rings = [(0.455, 0.022, 0.42), (0.30, 0.014, 0.20)]  # (rayon, épaisseur, alpha) relatifs

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            if sprite_hit(x, y):
                row.extend((255, 255, 255))
                continue
            r, g, b = NAVY  # fond navy uni
            # halo autour du sprite — très léger
            d2min = min((x - lx) ** 2 + (y - ly) ** 2 for (lx, ly) in lit[:: max(1, len(lit) // 20)])
            glow = math.exp(-d2min / (2 * (size * 0.045) ** 2)) * 0.16
            # anneaux
            dist = math.hypot(x - cx, y - cy) / size
            ring_a = 0.0
            for (rr, th, al) in rings:
                ring_a = max(ring_a, al * math.exp(-((dist - rr) ** 2) / (2 * (th / 2.2) ** 2)))
            a = min(1.0, glow + ring_a)
            row.extend((
                int(r + (255 - r) * a),
                int(g + (255 - g) * a),
                int(b + (255 - b) * a),
            ))
        rows.append(row)
    return png(size, size, rows)


out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(out_dir, exist_ok=True)
for size in (180, 192, 512):
    path = os.path.join(out_dir, f"icon-{size}.png")
    with open(path, "wb") as f:
        f.write(make_icon(size))
    print(f"OK {path}")
