"""Génère les icônes PNG de la PWA (invader pixel-art sur fond dégradé violet).

Écrit en Python pur (zlib + struct) pour ne dépendre d'aucune lib d'image.
Usage : python scripts/gen_icons.py
"""
import struct, zlib, os

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

TOP = (0x8D, 0x75, 0xF2)     # violet clair
BOTTOM = (0x4C, 0x35, 0xA8)  # violet profond
FG = (0xFF, 0xFF, 0xFF)


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
    # sprite centré, occupant ~62 % de la largeur
    px = max(1, int(size * 0.62 / gw))
    ox = (size - gw * px) // 2
    oy = (size - gh * px) // 2
    rows = []
    for y in range(size):
        t = y / (size - 1)
        bg = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        row = []
        for x in range(size):
            gx, gy = (x - ox) // px, (y - oy) // px
            if 0 <= gx < gw and 0 <= gy < gh and SPRITE[gy][gx] == "X":
                row.extend(FG)
            else:
                row.extend(bg)
        rows.append(row)
    return png(size, size, rows)


out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(out_dir, exist_ok=True)
for size in (180, 192, 512):
    path = os.path.join(out_dir, f"icon-{size}.png")
    with open(path, "wb") as f:
        f.write(make_icon(size))
    print(f"OK {path}")
