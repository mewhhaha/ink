from __future__ import annotations

import re
import struct
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

PIXEL_UNITS = 64
UNITS_PER_EM = 1024
FONT_ASCENT = 12 * PIXEL_UNITS
FONT_DESCENT = 2 * PIXEL_UNITS


def read_wad(path: Path) -> dict[str, bytes]:
    data = path.read_bytes()
    kind, lump_count, directory_offset = struct.unpack_from("<4sii", data, 0)
    if kind not in (b"IWAD", b"PWAD"):
        raise ValueError(f"unsupported WAD type: {kind!r}")
    lumps: dict[str, bytes] = {}
    for index in range(lump_count):
        entry = directory_offset + index * 16
        offset, size, raw_name = struct.unpack_from("<ii8s", data, entry)
        name = raw_name.split(b"\0", 1)[0].decode("ascii")
        lumps.setdefault(name, data[offset : offset + size])
    return lumps


def patch_pixels(data: bytes) -> tuple[int, int, set[tuple[int, int]]]:
    width, height = struct.unpack_from("<HH", data, 0)
    offsets = struct.unpack_from(f"<{width}I", data, 8)
    pixels: set[tuple[int, int]] = set()
    for x, offset in enumerate(offsets):
        cursor = offset
        while True:
            top_delta = data[cursor]
            if top_delta == 255:
                break
            length = data[cursor + 1]
            start = cursor + 3
            for row in range(length):
                y = top_delta + row
                if y < height:
                    pixels.add((x, y))
            cursor = start + length + 1
    return width, height, pixels


def glyph_for_patch(data: bytes):
    width, height, pixels = patch_pixels(data)
    pen = TTGlyphPen(None)
    for x, y in sorted(pixels):
        left = x * PIXEL_UNITS
        right = (x + 1) * PIXEL_UNITS
        bottom = (height - y - 1) * PIXEL_UNITS
        top = (height - y) * PIXEL_UNITS
        pen.moveTo((left, bottom))
        pen.lineTo((right, bottom))
        pen.lineTo((right, top))
        pen.lineTo((left, top))
        pen.closePath()
    return pen.glyph(), (width + 1) * PIXEL_UNITS


def glyph_name(codepoint: int) -> str:
    return "space" if codepoint == 32 else f"uni{codepoint:04X}"


def build_font(wad_path: Path, output_path: Path) -> None:
    lumps = read_wad(wad_path)
    glyphs = {".notdef": TTGlyphPen(None).glyph(), "space": TTGlyphPen(None).glyph()}
    metrics = {
        ".notdef": (8 * PIXEL_UNITS, 0),
        "space": (4 * PIXEL_UNITS, 0),
    }
    cmap: dict[int, str] = {32: "space"}
    order = [".notdef", "space"]

    for codepoint in range(33, 127):
        lump = lumps.get(f"STCFN{codepoint:03d}")
        if lump is None:
            continue
        name = glyph_name(codepoint)
        glyph, advance = glyph_for_patch(lump)
        glyphs[name] = glyph
        metrics[name] = (advance, 0)
        cmap[codepoint] = name
        order.append(name)

    # Doom menu labels are uppercase, but mapping lowercase to the same
    # bitmap glyph keeps the font useful for semantic descriptions too.
    for codepoint in range(ord("a"), ord("z") + 1):
        upper = codepoint - 32
        name = glyph_name(upper)
        if name in glyphs:
            cmap[codepoint] = name

    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=FONT_ASCENT, descent=-FONT_DESCENT)
    builder.setupOS2(
        sTypoAscender=FONT_ASCENT,
        sTypoDescender=-FONT_DESCENT,
        usWinAscent=FONT_ASCENT,
        usWinDescent=FONT_DESCENT,
    )
    builder.setupNameTable({
        "familyName": "Freedoom",
        "styleName": "Bitmap",
        "fullName": "Freedoom Bitmap",
        "psName": "Freedoom-Bitmap",
    })
    builder.setupPost()
    builder.setupMaxp()
    font = builder.font
    font.flavor = "woff"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    font.save(output_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_freedoom_font.py INPUT.WAD OUTPUT.woff")
    build_font(Path(sys.argv[1]), Path(sys.argv[2]))
