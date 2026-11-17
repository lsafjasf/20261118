"""Minimal EBML (Matroska/WebM) reader/writer built on the Python stdlib."""

import struct


class EbmlError(Exception):
    pass


def read_vint(buf, pos, keep_marker=False):
    """Read an EBML variable-length integer.

    Returns (value, encoded_length). When keep_marker is True the length
    marker bit (and any reserved all-ones pattern) is preserved.
    """
    first = buf[pos]
    if first == 0:
        raise EbmlError(f"invalid VINT lead byte 0x00 at {pos}")
    width = 8 - first.bit_length() + 1
    raw = int.from_bytes(buf[pos:pos + width], "big")
    if keep_marker:
        return raw, width
    marker_mask = 1 << (8 * width - width)
    return raw - marker_mask, width


def encode_vint(value, width=None, unknown=False):
    """Encode an unsigned integer as an EBML VINT."""
    if unknown:
        if width is None:
            width = 8
        return b"\x01" + b"\xff" * (width - 1)
    if width is None:
        width = min_width(value)
    marker = 1 << (8 * width - width)
    if value >= marker:
        raise EbmlError(f"value {value} does not fit in VINT width {width}")
    return (value + marker).to_bytes(width, "big")


def min_width(value):
    """Smallest VINT width (1..8) that can hold value's data bits."""
    if value < 0:
        raise EbmlError("VINT cannot be negative")
    for width in range(1, 9):
        if value < (1 << (7 * width)) - 1:
            return width
    raise EbmlError(f"value {value} exceeds VINT range")


def read_elem_header(buf, pos, end=None):
    """Return (element_id, header_len, data_size, data_start).

    data_size is None for an unknown-size element; data_start points at the
    first payload byte.
    """
    if end is not None and pos >= end:
        raise EbmlError("read past end of buffer")
    elem_id, id_len = read_vint(buf, pos, keep_marker=True)
    size, size_len = read_vint(buf, pos + id_len)
    all_ones = (1 << (7 * size_len)) - 1
    data_size = None if size == all_ones else size
    header_len = id_len + size_len
    return elem_id, header_len, data_size, pos + header_len


def encode_element(elem_id, payload=b"", size_width=None):
    """Wrap payload in a full EBML element (unknown size when payload=None)."""
    id_bytes = elem_id.to_bytes((elem_id.bit_length() + 7) // 8, "big")
    if payload is None:
        return id_bytes + encode_vint(0, width=size_width or 8, unknown=True)
    if size_width is None:
        size_width = min_width(len(payload))
    return id_bytes + encode_vint(len(payload), width=size_width) + payload


def encode_uint(elem_id, value):
    if value == 0:
        body = b"\x00"
    else:
        body = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return encode_element(elem_id, body)


def encode_string(elem_id, text):
    return encode_element(elem_id, text.encode("utf-8"))


def encode_float(elem_id, value):
    return encode_element(elem_id, struct.pack(">d", value))


def iter_children(buf, start, end):
    """Yield (id, header_len, data_size, data_start, elem_end) tuples."""
    pos = start
    while pos < end:
        elem_id, header_len, data_size, data_start = read_elem_header(buf, pos)
        if data_size is None:
            raise EbmlError(f"unknown-size child at {pos}")
        elem_end = data_start + data_size
        if elem_end > end:
            raise EbmlError(f"element at {pos} overruns parent")
        yield elem_id, header_len, data_size, data_start, elem_end
        pos = elem_end


def find_child(buf, start, end, wanted_id):
    """First matching child element, or None."""
    for elem_id, _, data_size, data_start, elem_end in iter_children(buf, start, end):
        if elem_id == wanted_id:
            return data_start, data_size, elem_end
    return None


def read_uint(buf, start, size):
    return int.from_bytes(buf[start:start + size], "big")
