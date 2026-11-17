"""Generate a small synthetic, spec-shaped WebM file for testing the repair.

The output contains one VP8 video track and one Opus audio track. Frames are
minimal payloads; the important part for Cue recovery is the EBML structure,
cluster timecodes and SimpleBlock keyframe flags, which this writer emits
exactly like a real muxer.
"""

import argparse
import struct

from . import ebml
from . import webm_ids as W


def make_simple_block(track_number, rel_timecode, payload, keyframe):
    header = ebml.encode_vint(track_number)
    header += struct.pack(">h", rel_timecode)
    flags = (0x80 if keyframe else 0x00) | (W.LACING_NONE << 1)
    return ebml.encode_element(W.SIMPLE_BLOCK, header + payload)


def vp8_frame(width, height, keyframe):
    """A minimal VP8 frame: valid frame tag plus data chunk header for keys."""
    if keyframe:
        # Frame tag: frame_type=0 (key), version=0, show_frame=1, part0_size=9
        tag = bytes([0x90, 0x01, 0x00])
        start_code = bytes([0x9D, 0x01, 0x2A])
        horiz = width | (width << 16)
        vert = height | (height << 16)
        data = start_code + struct.pack("<II", horiz, vert)
        return tag + data
    # Delta frame tag: frame_type=1, show=1, tiny payload size 1
    return bytes([0x10, 0x01, 0x00]) + b"\x00"


def opus_packet(frame_index):
    # 1-byte TOC: code 0 (single 20 ms frame), config 16, stereo=0.
    return bytes([0x10 | (frame_index & 0x01)])


def build_tracks(video_number=1, audio_number=2):
    video = b"".join([
        ebml.encode_element(W.TRACK_ENTRY, b"".join([
            ebml.encode_uint(W.TRACK_NUMBER, video_number),
            ebml.encode_uint(W.TRACK_UID, 1001),
            ebml.encode_uint(W.TRACK_TYPE, W.TRACK_TYPE_VIDEO),
            ebml.encode_string(W.CODEC_ID, "V_VP8"),
            ebml.encode_uint(W.DEFAULT_DURATION, 1_000_000_000 // 24),
            ebml.encode_element(0xE0,  # Video
                                ebml.encode_uint(W.PIXEL_WIDTH, 160) +
                                ebml.encode_uint(W.PIXEL_HEIGHT, 120)),
        ])),
        ebml.encode_element(W.TRACK_ENTRY, b"".join([
            ebml.encode_uint(W.TRACK_NUMBER, audio_number),
            ebml.encode_uint(W.TRACK_UID, 1002),
            ebml.encode_uint(W.TRACK_TYPE, W.TRACK_TYPE_AUDIO),
            ebml.encode_string(W.CODEC_ID, "A_OPUS"),
        ])),
    ])
    return ebml.encode_element(W.TRACKS, video)


def build_info(duration_ms):
    info = b"".join([
        ebml.encode_uint(W.TIMESTAMP_SCALE, 1_000_000),
        ebml.encode_float(W.DURATION, float(duration_ms)),
        ebml.encode_string(W.MUXING_APP, "webm-rebuild-demo"),
        ebml.encode_string(W.WRITING_APP, "webm-rebuild-demo"),
    ])
    return ebml.encode_element(W.INFO, info)


def build_ebml_header():
    body = b"".join([
        ebml.encode_uint(0x4286, 1),          # EBMLVersion
        ebml.encode_uint(0x42F7, 1),          # EBMLReadVersion
        ebml.encode_uint(0x42F2, 4),          # EBMLMaxIDLength
        ebml.encode_uint(0x42F3, 8),          # EBMLMaxSizeLength
        ebml.encode_string(0x4282, "webm"),   # DocType
        ebml.encode_uint(0x4287, 2),          # DocTypeVersion
        ebml.encode_uint(0x4285, 2),          # DocTypeReadVersion
    ])
    return ebml.encode_element(W.EBML_HEADER, body)


def build_cues(entries):
    from .rebuilder import encode_cues  # reuse the real encoder

    class _Holder:
        pass

    return encode_cues(_Holder(), entries)


def generate(duration_s=30, fps=24, keyframe_every=48,
             video_number=1, audio_number=2):
    """Return (file_bytes, cue_entries) for a synthetic clip."""
    clusters = []
    cue_entries = []
    total_frames = duration_s * fps

    for second in range(duration_s):
        cluster_body = [ebml.encode_uint(W.CLUSTER_TIMECODE, second * 1000)]
        # 24 video frames per second; first frame of each 2 s window is a key.
        for frame_in_second in range(fps):
            frame_index = second * fps + frame_in_second
            keyframe = frame_index % keyframe_every == 0
            rel_tc = round(frame_in_second * 1000 / fps)
            payload = vp8_frame(160, 120, keyframe)
            cluster_body.append(
                make_simple_block(video_number, rel_tc, payload, keyframe)
            )
            if keyframe:
                # Offset patched later once clusters are laid out.
                cue_entries.append((frame_index * 1000 // fps,
                                    {video_number: None}))
        # 50 Opus packets (20 ms each) per second.
        for packet_index in range(50):
            rel_tc = packet_index * 20
            payload = opus_packet(second * 50 + packet_index)
            cluster_body.append(
                make_simple_block(audio_number, rel_tc, payload, True)
            )
        clusters.append(ebml.encode_element(W.CLUSTER, b"".join(cluster_body)))

    header = build_ebml_header()
    info = build_info(duration_s * 1000)
    tracks = build_tracks(video_number, audio_number)
    segment_body_wo_cues = info + tracks + b"".join(clusters)

    # Segment uses an unknown size (VINT 0x01FFFFFFFFFFFFFF), legal in WebM.
    segment = W.SEGMENT.to_bytes(4, "big") + ebml.encode_vint(
        0, width=8, unknown=True
    ) + segment_body_wo_cues
    base = header + segment

    # Recompute cluster-relative offsets by scanning the laid-out bytes.
    from .scanner import scan_bytes
    result = scan_bytes(base)
    offset_by_tc = {}
    for cluster in result.clusters:
        for frame in cluster.frames:
            if frame.track_number == video_number and frame.keyframe:
                abs_tc = cluster.timecode_ms + frame.rel_timecode
                offset_by_tc[abs_tc] = cluster.seg_relative_offset
    fixed_entries = []
    for timecode_ms, _ in cue_entries:
        fixed_entries.append(
            (timecode_ms, {video_number: offset_by_tc[timecode_ms]})
        )
    return base + build_cues(fixed_entries), fixed_entries


def corrupt_cues(path, mode="garbage"):
    """Damage the Cues payload while leaving all Clusters byte-identical."""
    from .scanner import scan

    result = scan(path)
    if not result.cues_elements:
        raise RuntimeError("file has no Cues element to corrupt")
    data_start, data_size, elem_end = result.cues_elements[0]
    with open(path, "rb") as handle:
        blob = bytearray(handle.read())
    if mode == "garbage":
        # Keep ID/size header; overwrite payload so cue entries are unparsable.
        for idx in range(data_start, elem_end):
            blob[idx] = 0xAA
    elif mode == "truncate":
        # Drop the whole Cues element, including its ID/size header.
        elem_start = _cues_element_start(blob, data_start)
        del blob[elem_start:elem_end]
    else:
        raise ValueError(f"unknown corruption mode {mode}")
    with open(path, "wb") as handle:
        handle.write(blob)


def _cues_element_start(blob, data_start):
    cue_id = W.CUES.to_bytes(4, "big")
    needle_start = max(0, data_start - 12)
    idx = blob.rfind(cue_id, needle_start, data_start)
    if idx < 0:
        raise RuntimeError("could not locate Cues element header")
    return idx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_path")
    parser.add_argument("--duration", type=int, default=30)
    parser.add_argument("--corrupt", choices=["garbage", "truncate"])
    args = parser.parse_args()
    blob, _ = generate(duration_s=args.duration)
    with open(args.out_path, "wb") as handle:
        handle.write(blob)
    if args.corrupt:
        corrupt_cues(args.out_path, mode=args.corrupt)


if __name__ == "__main__":
    main()
