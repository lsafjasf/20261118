"""Safe metadata editing: whitelist of fields that may change.

Audio samples (data chunk) and structural fmt/bext numeric fields are
never modified. Export re-parses the result and verifies that the chunk
structure is unchanged and the data chunk is byte-identical.
"""
from __future__ import annotations

import hashlib

from . import bext as bext_mod
from . import cue as cue_mod
from . import ixml as ixml_mod
from .riff import WaveFile, build_wave, parse_wave

# field name -> handler kind; anything not listed here is rejected
SAFE_FIELDS = {
    "bext.description": "bext_ascii",
    "bext.originator": "bext_ascii",
    "bext.originator_reference": "bext_ascii",
    "bext.origination_date": "bext_ascii",
    "bext.origination_time": "bext_ascii",
    "ixml.PROJECT": "ixml",
    "ixml.SCENE": "ixml",
    "ixml.TAKE": "ixml",
    "ixml.TAPE": "ixml",
    "ixml.NOTE": "ixml",
    "cue.label": "cue_label",   # value syntax: "<cue_id>=<text>"
}


class EditError(ValueError):
    pass


def set_field(wave: WaveFile, field: str, value: str) -> None:
    kind = SAFE_FIELDS.get(field)
    if kind is None:
        raise EditError(
            f"field {field!r} is not editable; safe fields: "
            + ", ".join(sorted(SAFE_FIELDS)))
    if kind == "bext_ascii":
        chunk = wave.find(b"bext")
        if chunk is None:
            raise EditError("no bext chunk to edit")
        wave.replace(chunk, bext_mod.set_bext_ascii(
            chunk, field.split(".", 1)[1], value))
    elif kind == "ixml":
        chunk = wave.find(b"iXML")
        if chunk is None:
            raise EditError("no iXML chunk to edit")
        wave.replace(chunk, ixml_mod.set_ixml_value(
            chunk, field.split(".", 1)[1], value))
    elif kind == "cue_label":
        cue_id_s, _, text = value.partition("=")
        if not text:
            raise EditError("cue.label value must be '<cue_id>=<text>'")
        lst = next((c for c in wave.find_all(b"LIST")
                    if c.payload[:4] == b"adtl"), None)
        if lst is None:
            raise EditError("no LIST/adtl chunk to edit")
        cue_mod.set_cue_label(wave, lst, int(cue_id_s), text)


def _data_digest(wave: WaveFile) -> tuple[str, int] | None:
    chunk = wave.find(b"data")
    if chunk is None:
        return None
    return hashlib.sha256(chunk.payload).hexdigest(), chunk.size


def export_wave(wave: WaveFile) -> bytes:
    """Serialize and verify: same chunk structure, identical audio data."""
    before_ids = [c.cid for c in wave.chunks]
    before_data = _data_digest(wave)
    blob = build_wave(wave)
    again = parse_wave(blob)
    after_ids = [c.cid for c in again.chunks]
    if after_ids != before_ids:
        raise EditError(
            f"chunk structure changed on export: {before_ids} -> {after_ids}")
    if _data_digest(again) != before_data:
        raise EditError("audio data chunk changed on export")
    return blob
