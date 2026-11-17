"""Pure-python MP4/MOV sample-table parser.

Builds a keyframe index (GOP first frames only) from the stss/stts/ctts/
stsc/stsz/stco boxes, and applies the edit list (elst) so that reported
times are presentation times as a player would see them.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

_CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"}


@dataclass
class Box:
    type: bytes
    start: int          # offset of box header
    size: int           # total box size including header
    data_offset: int    # offset of payload
    children: list = field(default_factory=list)


def _read_boxes(f, end, depth=0):
    boxes = []
    while f.tell() < end:
        start = f.tell()
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        size, btype = struct.unpack(">I4s", hdr)
        header = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            header = 16
        elif size == 0:
            f.seek(0, 2)
            size = f.tell() - start
        if size < header:
            break
        box = Box(btype, start, size, start + header)
        if btype in _CONTAINER_BOXES and depth < 8:
            pos = f.tell()
            box.children = _read_boxes(f, start + size, depth + 1)
            f.seek(pos)
        f.seek(start + size)
        boxes.append(box)
    return boxes


def _find(boxes, *path):
    """Walk a path of box types, return first match or None."""
    cur = boxes
    box = None
    for t in path:
        box = next((b for b in cur if b.type == t), None)
        if box is None:
            return None
        cur = box.children
    return box


def _u32(data, off):
    return struct.unpack_from(">I", data, off)[0]


def _parse_fullbox(data):
    version = data[0]
    return version, 4  # version + flags consumed


@dataclass
class Keyframe:
    sample_index: int        # decode-order sample number (0-based)
    frame_number: int        # presentation frame number as a player shows it
    pts_seconds: float       # presentation time after edit list
    media_pts_seconds: float # raw media time before edit list
    file_offset: int         # absolute byte offset of the sample in file
    size: int                # sample size in bytes
    presented: bool = True   # False when the edit list drops this frame


@dataclass
class VideoIndex:
    path: str
    timescale: int
    duration_seconds: float
    edit_list: list          # [(segment_duration_s, media_time_s, rate)]
    media_time_offset: float # seconds of media skipped at presentation t=0
    keyframes: list
    sample_count: int
    all_sync: bool           # True when no stss box (every sample is a keyframe)
    notes: list = field(default_factory=list)

    @property
    def gop_interval(self):
        """Estimated keyframe interval in seconds (median of deltas)."""
        if len(self.keyframes) < 2:
            return None
        deltas = [
            b.pts_seconds - a.pts_seconds
            for a, b in zip(self.keyframes, self.keyframes[1:])
        ]
        deltas.sort()
        return deltas[len(deltas) // 2]


def _load(f, box):
    f.seek(box.data_offset)
    return f.read(box.size - (box.data_offset - box.start))


def _parse_mdhd(data):
    version, base = _parse_fullbox(data)
    if version == 1:
        timescale = _u32(data, base + 16)
        duration = struct.unpack_from(">Q", data, base + 20)[0]
    else:
        timescale = _u32(data, base + 8)
        duration = _u32(data, base + 12)
    return timescale, duration


def _parse_stts(data):
    _, base = _parse_fullbox(data)
    count = _u32(data, base)
    entries, off = [], base + 4
    for _ in range(count):
        entries.append((_u32(data, off), _u32(data, off + 4)))
        off += 8
    return entries  # (sample_count, sample_delta)


def _parse_ctts(data):
    version, base = _parse_fullbox(data)
    count = _u32(data, base)
    entries, off = [], base + 4
    for _ in range(count):
        n = _u32(data, off)
        raw = _u32(data, off + 4)
        if version == 1 and raw >= 0x80000000:
            raw -= 0x100000000  # signed offset
        entries.append((n, raw))
        off += 8
    return entries  # (sample_count, composition_offset)


def _parse_stss(data):
    _, base = _parse_fullbox(data)
    count = _u32(data, base)
    return [_u32(data, base + 4 + 4 * i) for i in range(count)]  # 1-based


def _parse_stsz(data):
    _, base = _parse_fullbox(data)
    default_size = _u32(data, base)
    count = _u32(data, base + 4)
    if default_size:
        return [default_size] * count
    return [_u32(data, base + 8 + 4 * i) for i in range(count)]


def _parse_stsc(data):
    _, base = _parse_fullbox(data)
    count = _u32(data, base)
    entries, off = [], base + 4
    for _ in range(count):
        entries.append(
            (_u32(data, off), _u32(data, off + 4), _u32(data, off + 8))
        )
        off += 12
    return entries  # (first_chunk, samples_per_chunk, desc_idx), 1-based


def _parse_stco(data):
    _, base = _parse_fullbox(data)
    count = _u32(data, base)
    if len(data) >= base + 4 + 8 * count and data[:1] == b"\x00":
        pass
    return [_u32(data, base + 4 + 4 * i) for i in range(count)]


def _parse_co64(data):
    _, base = _parse_fullbox(data)
    count = _u32(data, base)
    return [
        struct.unpack_from(">Q", data, base + 4 + 8 * i)[0]
        for i in range(count)
    ]


def _parse_elst(data, timescale):
    version, base = _parse_fullbox(data)
    count = _u32(data, base)
    entries, off = [], base + 4
    for _ in range(count):
        if version == 1:
            seg = struct.unpack_from(">Q", data, off)[0]
            media = struct.unpack_from(">q", data, off + 8)[0]
            off += 20
        else:
            seg = _u32(data, off)
            raw = _u32(data, off + 4)
            media = raw - 0x100000000 if raw >= 0x80000000 else raw
            off += 12
        entries.append((seg, media))
    return entries  # (segment_duration in movie ts, media_time in media ts)


def _expand_rle(entries, total):
    out = []
    for count, value in entries:
        out.extend([value] * count)
    return out[:total]


def _sample_offsets(sizes, stsc, chunk_offsets):
    """Compute absolute file offset of every sample."""
    offsets = [0] * len(sizes)
    sample = 0
    stsc_i = 0
    for chunk_i, chunk_off in enumerate(chunk_offsets, start=1):
        while (
            stsc_i + 1 < len(stsc) and stsc[stsc_i + 1][0] <= chunk_i
        ):
            stsc_i += 1
        per_chunk = stsc[stsc_i][1]
        pos = chunk_off
        for _ in range(per_chunk):
            if sample >= len(sizes):
                break
            offsets[sample] = pos
            pos += sizes[sample]
            sample += 1
    return offsets


def build_index(path):
    """Parse an MP4/MOV file and return a VideoIndex of GOP first frames."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        f.seek(0)
        top = _read_boxes(f, end)

        moov = _find(top, b"moov")
        if moov is None:
            raise ValueError("no moov box: not a (faststart) MP4/MOV file")

        mvhd = _find(moov.children, b"mvhd")
        movie_timescale = 1000
        if mvhd is not None:
            data = _load(f, mvhd)
            version, base = _parse_fullbox(data)
            movie_timescale = (
                _u32(data, base + 16) if version == 1 else _u32(data, base + 8)
            )

        # pick the first video track
        vtrak = None
        for trak in [b for b in moov.children if b.type == b"trak"]:
            hdlr = _find(trak.children, b"mdia", b"hdlr")
            if hdlr is None:
                continue
            data = _load(f, hdlr)
            if data[8:12] == b"vide":
                vtrak = trak
                break
        if vtrak is None:
            raise ValueError("no video track found")

        mdhd = _find(vtrak.children, b"mdia", b"mdhd")
        timescale, duration = _parse_mdhd(_load(f, mdhd))

        stbl = _find(vtrak.children, b"mdia", b"minf", b"stbl")
        if stbl is None:
            raise ValueError("no sample table (stbl) in video track")

        def load_box(name):
            box = _find(stbl.children, name)
            return _load(f, box) if box is not None else None

        sizes = _parse_stsz(load_box(b"stsz"))
        stts = _parse_stts(load_box(b"stts"))
        ctts_box = load_box(b"ctts")
        ctts = _parse_ctts(ctts_box) if ctts_box else None
        stsc = _parse_stsc(load_box(b"stsc"))
        stco_box = load_box(b"stco")
        chunk_offsets = (
            _parse_stco(stco_box)
            if stco_box
            else _parse_co64(load_box(b"co64"))
        )
        stss_box = load_box(b"stss")
        sync = (
            set(_parse_stss(stss_box))
            if stss_box
            else set(range(1, len(sizes) + 1))
        )

        # edit list
        edit_list, media_offset = [], 0.0
        elst_box = _find(vtrak.children, b"edts", b"elst")
        if elst_box is not None:
            for seg, media in _parse_elst(_load(f, elst_box), timescale):
                edit_list.append(
                    (
                        seg / movie_timescale,
                        None if media < 0 else media / timescale,
                    )
                )
            for seg, media in edit_list:
                if media is not None:
                    media_offset = media
                    break

        # per-sample decode/presentation timestamps
        deltas = _expand_rle(stts, len(sizes))
        dts, t = [], 0
        for d in deltas:
            dts.append(t)
            t += d
        if ctts:
            coff = _expand_rle(ctts, len(sizes))
        else:
            coff = [0] * len(sizes)
        pts = [d + c for d, c in zip(dts, coff)]
        offsets = _sample_offsets(sizes, stsc, chunk_offsets)

        # presentation-order rank of every sample (frame number)
        order = sorted(range(len(pts)), key=lambda i: (pts[i], i))
        rank = [0] * len(pts)
        for r, sample_i in enumerate(order):
            rank[sample_i] = r

        # frames whose presentation time falls before the edit-list start
        # are dropped by players; renumber so frame_number matches what a
        # decoder outputs (e.g. ffmpeg's presentation frame index)
        pres = [p / timescale - media_offset for p in pts]
        dropped = sum(1 for p in pres if p < -1e-9)

        keyframes = []
        for i in range(len(sizes)):
            if (i + 1) not in sync:
                continue
            keyframes.append(
                Keyframe(
                    sample_index=i,
                    frame_number=rank[i] - dropped,
                    pts_seconds=pres[i],
                    media_pts_seconds=pts[i] / timescale,
                    file_offset=offsets[i],
                    size=sizes[i],
                    presented=pres[i] >= -1e-9,
                )
            )
        keyframes.sort(key=lambda k: k.pts_seconds)

        notes = []
        if stss_box is None:
            notes.append(
                "no stss box: container marks every sample as a sync sample"
            )
        if edit_list:
            notes.append(f"edit list present: {edit_list}")
        if dropped:
            notes.append(
                f"edit list drops {dropped} leading frame(s); frame "
                "numbers are renumbered to match decoder output"
            )

        return VideoIndex(
            path=path,
            timescale=timescale,
            duration_seconds=duration / timescale,
            edit_list=edit_list,
            media_time_offset=media_offset,
            keyframes=keyframes,
            sample_count=len(sizes),
            all_sync=stss_box is None,
            notes=notes,
        )
