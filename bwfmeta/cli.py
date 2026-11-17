"""Command line interface: parse / check / set / export."""
from __future__ import annotations

import argparse
import sys

from . import bext as bext_mod
from . import cue as cue_mod
from . import fmt as fmt_mod
from . import ixml as ixml_mod
from .check import check_wave
from .edit import SAFE_FIELDS, EditError, export_wave, set_field
from .riff import parse_wave


def _load(path: str):
    with open(path, "rb") as fh:
        return parse_wave(fh.read())


def cmd_parse(args) -> int:
    wave = _load(args.file)
    print(f"chunks ({len(wave.chunks)}):")
    for c in wave.chunks:
        tag = "" if c.known else "  <-- UNKNOWN"
        print(f"  0x{c.offset:08x}  {c.cid.decode('latin-1')!r:8} "
              f"size={c.size}{tag}")
    fmt_chunk = wave.find(b"fmt ")
    if fmt_chunk:
        f = fmt_mod.parse_fmt(fmt_chunk)
        print(f"\nfmt: format=0x{f.audio_format:04x} ch={f.channels} "
              f"rate={f.sample_rate} bits={f.bits_per_sample} "
              f"align={f.block_align} byte_rate={f.byte_rate}")
        if f.channel_mask is not None:
            names = fmt_mod.mask_speakers(f.channel_mask)
            print(f"     valid_bits={f.valid_bits} "
              f"mask=0x{f.channel_mask:x} {names} sub={f.sub_format}")
    bext_chunk = wave.find(b"bext")
    if bext_chunk:
        b = bext_mod.parse_bext(bext_chunk)
        print(f"\nbext @ 0x{bext_chunk.offset:08x}: v{b.version}")
        print(f"  description           {b.description!r}")
        print(f"  originator            {b.originator!r}")
        print(f"  originator_reference  {b.originator_reference!r}")
        print(f"  origination_date      {b.origination_date!r}")
        print(f"  origination_time      {b.origination_time!r}")
        print(f"  time_reference        {b.time_reference} "
              f"@ 0x{b.field_offset('time_reference'):08x}")
    ixml_chunk = wave.find(b"iXML")
    if ixml_chunk:
        x = ixml_mod.parse_ixml(ixml_chunk)
        print(f"\niXML @ 0x{ixml_chunk.offset:08x}:")
        for k, v in x.values.items():
            print(f"  {k:34s} {v!r}")
    cue_chunk = wave.find(b"cue ")
    if cue_chunk:
        ci = cue_mod.parse_cue(cue_chunk)
        cue_mod.attach_labels(wave, ci)
        print(f"\ncue @ 0x{cue_chunk.offset:08x}: {len(ci.points)} points")
        for p in ci.points:
            print(f"  id={p.cue_id} sample={p.sample_offset} "
                  f"label={p.label!r}")
    return 0


def cmd_check(args) -> int:
    wave = _load(args.file)
    findings = check_wave(wave)
    if not findings:
        print("OK: no consistency problems found")
        return 0
    for f in findings:
        print(f)
    return 1 if any(f.severity == "error" for f in findings) else 0


def cmd_set(args) -> int:
    wave = _load(args.file)
    try:
        set_field(wave, args.field, args.value)
        blob = export_wave(wave)
    except EditError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    out = args.output or args.file
    with open(out, "wb") as fh:
        fh.write(blob)
    print(f"wrote {out} ({len(blob)} bytes); chunk structure and audio "
          f"data verified unchanged")
    return 0


def cmd_fields(_args) -> int:
    print("safe editable fields:")
    for name in sorted(SAFE_FIELDS):
        print(f"  {name}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bwfmeta",
                                 description="Broadcast WAV metadata tool")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse", help="dump chunk structure and fields")
    p.add_argument("file")
    p.set_defaults(fn=cmd_parse)
    p = sub.add_parser("check", help="run cross-chunk consistency checks")
    p.add_argument("file")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("set", help="edit a safe metadata field and export")
    p.add_argument("file")
    p.add_argument("field")
    p.add_argument("value")
    p.add_argument("-o", "--output")
    p.set_defaults(fn=cmd_set)
    p = sub.add_parser("fields", help="list safe editable fields")
    p.set_defaults(fn=cmd_fields)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
