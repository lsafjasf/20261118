"""Scan a WebM file and recover track, cluster, keyframe and offset info."""

from dataclasses import dataclass, field

from . import ebml
from . import webm_ids as W


@dataclass
class Track:
    number: int
    uid: int | None
    track_type: int | None
    codec_id: str
    default_duration: int | None = None
    pixel_width: int | None = None
    pixel_height: int | None = None

    @property
    def kind(self):
        return {W.TRACK_TYPE_VIDEO: "video", W.TRACK_TYPE_AUDIO: "audio"}.get(
            self.track_type, "unknown"
        )


@dataclass
class Frame:
    track_number: int
    rel_timecode: int
    keyframe: bool
    lacing: int
    block_abs_offset: int
    payload_offset: int
    payload_size: int


@dataclass
class ClusterInfo:
    index: int
    abs_offset: int          # file offset of Cluster element header
    seg_relative_offset: int # CueClusterPosition value (relative to segment data)
    timecode_ms: int
    elem_end: int            # file offset just past the Cluster element
    frames: list = field(default_factory=list)


@dataclass
class ScanResult:
    file_size: int
    segment_abs_offset: int
    segment_header_len: int
    segment_data_start: int
    segment_size: int | None
    timestamp_scale: int
    duration_raw: float | None
    tracks: dict
    clusters: list
    cues_elements: list
    level1: list

    @property
    def duration_ms(self):
        if self.duration_raw is None:
            end = max((c.timecode_ms for c in self.clusters), default=0)
            return end
        return self.duration_raw * self.timestamp_scale / 1_000_000


def parse_block_header(buf, data_start, data_size, simple):
    """Parse a SimpleBlock/Block payload header."""
    pos = data_start
    track_number, tn_len = ebml.read_vint(buf, pos)
    pos += tn_len
    rel_tc = int.from_bytes(buf[pos:pos + 2], "big", signed=True)
    pos += 2
    flags = buf[pos]
    pos += 1
    lacing = (flags >> 1) & 0x03
    keyframe = bool(flags & 0x80) if simple else False
    payload_size = data_size - (pos - data_start)
    return Frame(
        track_number=track_number,
        rel_timecode=rel_tc,
        keyframe=keyframe,
        lacing=lacing,
        block_abs_offset=data_start,
        payload_offset=pos,
        payload_size=payload_size,
    )


def scan(path):
    with open(path, "rb") as handle:
        buf = handle.read()
    return scan_bytes(buf)


def scan_bytes(buf):
    file_size = len(buf)
    pos = 0
    segment = None
    level1 = []

    # EBML header must come first; skip any pre-segment top-level elements.
    while pos < file_size:
        elem_id, header_len, data_size, data_start = ebml.read_elem_header(buf, pos)
        elem_end = file_size if data_size is None else data_start + data_size
        level1.append((elem_id, pos, header_len, data_size, data_start, elem_end))
        if elem_id == W.SEGMENT:
            segment = (pos, header_len, data_size, data_start, elem_end)
            break
        pos = elem_end
    if segment is None:
        raise ebml.EbmlError("no Segment element found")

    seg_off, seg_hdr, seg_size, seg_data_start, seg_end = segment
    if seg_size is None:
        seg_end = file_size

    tracks = {}
    timestamp_scale = 1_000_000
    duration_raw = None
    clusters = []
    cues_elements = []

    for elem_id, header_len, data_size, data_start, elem_end in ebml.iter_children(
        buf, seg_data_start, seg_end
    ):
        if elem_id == W.INFO:
            for cid, _, csize, cstart, _ in ebml.iter_children(buf, data_start, elem_end):
                if cid == W.TIMESTAMP_SCALE:
                    timestamp_scale = ebml.read_uint(buf, cstart, csize)
                elif cid == W.DURATION:
                    duration_raw = _read_float_or_uint(buf, cstart, csize)
        elif elem_id == W.TRACKS:
            _parse_tracks(buf, data_start, elem_end, tracks)
        elif elem_id == W.CLUSTER:
            clusters.append(_parse_cluster(buf, data_start, elem_end,
                                           seg_data_start, len(clusters),
                                           data_start - header_len, elem_end))
        elif elem_id == W.CUES:
            cues_elements.append((data_start, data_size, elem_end))

    return ScanResult(
        file_size=file_size,
        segment_abs_offset=seg_off,
        segment_header_len=seg_hdr,
        segment_data_start=seg_data_start,
        segment_size=seg_size,
        timestamp_scale=timestamp_scale,
        duration_raw=duration_raw,
        tracks=tracks,
        clusters=clusters,
        cues_elements=cues_elements,
        level1=level1,
    )


def _read_float_or_uint(buf, start, size):
    if size == 4:
        import struct
        return struct.unpack(">f", buf[start:start + 4])[0]
    if size == 8:
        import struct
        return struct.unpack(">d", buf[start:start + 8])[0]
    return float(ebml.read_uint(buf, start, size))


def _parse_tracks(buf, start, end, tracks):
    for tid, _, tsize, tstart, tend in ebml.iter_children(buf, start, end):
        if tid != W.TRACK_ENTRY:
            continue
        entry = Track(number=0, uid=None, track_type=None, codec_id="")
        for cid, _, csize, cstart, cend in ebml.iter_children(buf, tstart, tend):
            if cid == W.TRACK_NUMBER:
                entry.number = ebml.read_uint(buf, cstart, csize)
            elif cid == W.TRACK_UID:
                entry.uid = ebml.read_uint(buf, cstart, csize)
            elif cid == W.TRACK_TYPE:
                entry.track_type = ebml.read_uint(buf, cstart, csize)
            elif cid == W.CODEC_ID:
                entry.codec_id = bytes(buf[cstart:cend]).decode("ascii").rstrip("\x00")
            elif cid == W.DEFAULT_DURATION:
                entry.default_duration = ebml.read_uint(buf, cstart, csize)
            elif cid == W.PIXEL_WIDTH:
                entry.pixel_width = ebml.read_uint(buf, cstart, csize)
            elif cid == W.PIXEL_HEIGHT:
                entry.pixel_height = ebml.read_uint(buf, cstart, csize)
        tracks[entry.number] = entry


def _parse_cluster(buf, start, end, seg_data_start, index,
                   elem_start, elem_end):
    cluster_tc = 0
    frames = []
    for cid, hlen, csize, cstart, cend in ebml.iter_children(buf, start, end):
        if cid == W.CLUSTER_TIMECODE:
            cluster_tc = ebml.read_uint(buf, cstart, csize)
        elif cid == W.SIMPLE_BLOCK:
            frame = parse_block_header(buf, cstart, csize, simple=True)
            frames.append(frame)
        elif cid == W.BLOCK_GROUP:
            is_keyframe = True
            block = None
            for gid, _, gsize, gstart, gend in ebml.iter_children(buf, cstart, cend):
                if gid == W.BLOCK:
                    block = parse_block_header(buf, gstart, gsize, simple=False)
                elif gid == 0xFB:  # ReferenceBlock -> P/B frame, not a keyframe
                    is_keyframe = False
            if block is not None:
                block.keyframe = is_keyframe
                frames.append(block)
    return ClusterInfo(
        index=index,
        abs_offset=elem_start,
        seg_relative_offset=elem_start - seg_data_start,
        timecode_ms=cluster_tc,
        elem_end=elem_end,
        frames=frames,
    )
