"""Tiny PPM (P6) reader used by the orientation tests."""

from __future__ import annotations


def load_ppm(path: str) -> tuple[int, int, bytes, int]:
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:2] != b"P6":
        raise ValueError(f"{path} is not a binary PPM file")
    pos = 2
    tokens = []
    while len(tokens) < 3:
        while blob[pos] in b" \t\n\r":
            pos += 1
        start = pos
        while blob[pos] not in b" \t\n\r":
            pos += 1
        tokens.append(int(blob[start:pos]))
    return tokens[0], tokens[1], blob[pos + 1:], tokens[2]


def pixel(path: str, x: int, y: int) -> tuple[int, int, int]:
    width, height, data, _ = load_ppm(path)
    offset = (y * width + x) * 3
    return tuple(data[offset:offset + 3])


def corners(path: str, inset: int = 20) -> dict:
    width, height, _, _ = load_ppm(path)
    return {
        "TL": pixel(path, inset, inset),
        "TR": pixel(path, width - 1 - inset, inset),
        "BL": pixel(path, inset, height - 1 - inset),
        "BR": pixel(path, width - 1 - inset, height - 1 - inset),
    }
