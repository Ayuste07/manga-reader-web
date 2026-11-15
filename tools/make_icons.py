"""Genera los iconos PNG de la app (solo librería estándar).

Uso:  python web/tools/make_icons.py
Dibujo: fondo oscuro con tres páginas apiladas en vertical separadas por un hueco,
que es justo lo que hace el lector (scroll continuo con corte visible).
"""
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"


def png(path, size, pixel):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x / size, y / size))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    path.write_bytes(data)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(u, v):
    bg = (14, 14, 16)
    # Página superior (cortada por arriba), central completa, inferior (cortada por abajo).
    pages = [(-0.20, 0.20), (0.27, 0.73), (0.80, 1.20)]
    for i, (top, bottom) in enumerate(pages):
        if inside_round_rect(u, v, 0.22, top, 0.78, bottom, 0.035):
            # Viñetas: líneas finas oscuras dentro de la página central.
            if i == 1 and (abs(v - 0.47) < 0.008 or (v > 0.47 and abs(u - 0.52) < 0.008)):
                return (40, 40, 44)
            shade = 255 if i == 1 else 150
            return (shade, shade, shade)
    # Acento rojo: el número de página en el hueco.
    if inside_round_rect(u, v, 0.46, 0.745, 0.54, 0.785, 0.02) or inside_round_rect(u, v, 0.46, 0.215, 0.54, 0.255, 0.02):
        return (230, 57, 70)
    return bg


OUT.mkdir(exist_ok=True)
for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    png(OUT / name, size, pixel)
    print("ok", name)
