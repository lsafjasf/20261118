#!/usr/bin/env python3
"""MPEG-TS test stream generator with fault injection.

Generates a syntactically valid TS stream (PAT/PMT/PCR + A/V PES packets)
and can inject: single packet loss, burst packet loss, or normal A/V
interleaving (no fault). Used to validate tsanalyze.py.
"""
import argparse
import json
import struct

TS_PACKET_SIZE = 188
SYNC_BYTE = 0x47

PID_PAT = 0x0000
PID_PMT = 0x0100
PID_VIDEO = 0x0101
PID_AUDIO = 0x0102

CLOCK_27MHZ = 27_000_000


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 \
                else (crc << 1) & 0xFFFFFFFF
    return crc


class PacketBuilder:
    """Builds TS packets while tracking continuity counters per PID."""

    def __init__(self):
        self.cc = {}

    def _next_cc(self, pid: int) -> int:
        cc = self.cc.get(pid, 0)
        self.cc[pid] = (cc + 1) & 0xF
        return cc

    def packet(self, pid: int, payload: bytes, pusi: bool = False,
               pcr: int = None) -> bytes:
        """Build one 188-byte TS packet.

        pcr: 27 MHz clock value; when set, an adaptation field carrying the
        PCR is prepended (payload is shortened accordingly).
        """
        assert len(payload) <= 184
        afc = 0x1  # payload only
        adaptation = b""
        if pcr is not None:
            pcr_base = pcr // 300
            pcr_ext = pcr % 300
            # 33-bit base, 6 reserved bits, 9-bit extension
            pcr_field = struct.pack(
                ">Q",
                ((pcr_base & 0x1FFFFFFFF) << 15) | (0x3F << 9) | (pcr_ext & 0x1FF),
            )[2:]  # low 6 bytes
            flags = 0x10  # PCR_flag
            adaptation = bytes([7, flags]) + pcr_field
            afc = 0x3  # adaptation + payload
        cc = self._next_cc(pid)
        header = bytes([
            SYNC_BYTE,
            (0x40 if pusi else 0x00) | ((pid >> 8) & 0x1F),
            pid & 0xFF,
            (afc << 4) | cc,
        ])
        body = adaptation + payload
        if len(body) > 184:
            raise ValueError("payload too large for adaptation field")
        if afc == 0x3:
            # pad inside adaptation field with stuffing
            stuffing = 184 - len(body)
            if stuffing:
                afl = adaptation[0] + stuffing
                adaptation = bytes([afl, adaptation[1]]) + adaptation[2:] + b"\xFF" * stuffing
                body = adaptation + payload
        else:
            body = body + b"\xFF" * (184 - len(body))
        pkt = header + body
        assert len(pkt) == TS_PACKET_SIZE
        return pkt


def build_pat(builder: PacketBuilder) -> bytes:
    # one program: program_number 1 -> PMT PID 0x0100
    section = struct.pack(">H", 1) + b"\xC1\x00\x00"  # TSID, version 0, ssn 0, lsn 0
    section += struct.pack(">H", 1)  # program_number
    section += struct.pack(">H", 0xE000 | PID_PMT)
    section_length = len(section) + 4  # bytes after section_length, incl. CRC
    table = bytes([0x00, 0xB0 | (section_length >> 8), section_length & 0xFF]) + section
    table += struct.pack(">I", crc32_mpeg(table))
    return builder.packet(PID_PAT, b"\x00" + table, pusi=True)


def build_pmt(builder: PacketBuilder) -> bytes:
    streams = (
        bytes([0x1B]) + struct.pack(">H", 0xE000 | PID_VIDEO) + struct.pack(">H", 0xF000) +
        bytes([0x0F]) + struct.pack(">H", 0xE000 | PID_AUDIO) + struct.pack(">H", 0xF000)
    )
    section = struct.pack(">H", 1) + b"\xC1\x00\x00"
    section += struct.pack(">H", 0xE000 | PID_VIDEO)  # PCR_PID = video
    section += struct.pack(">H", 0xF000)              # program_info_length = 0
    section += streams
    section_length = len(section) + 4
    table = bytes([0x02, 0xB0 | (section_length >> 8), section_length & 0xFF]) + section
    table += struct.pack(">I", crc32_mpeg(table))
    return builder.packet(PID_PMT, b"\x00" + table, pusi=True)


def pes_packet(stream_id: int, data_len: int, pts_90k: int) -> bytes:
    """Minimal PES header with PTS, payload stuffed with pattern bytes."""
    pts = pts_90k & 0x1FFFFFFFF
    pts_bytes = bytes([
        0x21 | (((pts >> 30) & 0x7) << 1),
        (pts >> 22) & 0xFF,
        (((pts >> 15) & 0x7F) << 1) | 1,
        (pts >> 7) & 0xFF,
        ((pts & 0x7F) << 1) | 1,
    ])
    header = b"\x00\x00\x01" + bytes([stream_id])
    pes_len = 3 + 5 + data_len  # flags(2)+hdrlen(1) + pts(5) + data
    header += struct.pack(">H", pes_len if pes_len < 0xFFFF else 0)
    header += b"\x80\x00\x05" + pts_bytes  # no scrambling, PTS only
    return header + bytes((i & 0xFF) for i in range(data_len))


def split_pes(builder: PacketBuilder, pid: int, pes: bytes,
              pcr: int = None) -> list:
    """Split a PES packet into TS packets; PCR rides on the first one."""
    packets = []
    first = True
    offset = 0
    while offset < len(pes) or first:
        capacity = 184 - (8 if (first and pcr is not None) else 0)
        chunk = pes[offset:offset + capacity]
        packets.append(builder.packet(
            pid, chunk, pusi=first, pcr=pcr if first else None))
        offset += capacity
        first = False
        if not pes:
            break
    return packets


def generate(duration_ms: int = 2000, pcr_rollback_frame: int = None) -> list:
    """Generate the packet sequence (list of dicts with pkt/pid/meta).

    Layout: PAT+PMT every 100 ms; video frame (25 fps) split into several
    TS packets with PCR on the first; audio frame (AAC-ish, ~46.9 fps)
    interleaved between video packets -- this is normal A/V interleaving.
    """
    builder = PacketBuilder()
    out = []
    pcr_27k = 10 * CLOCK_27MHZ  # start at 10 s, like a real broadcast
    rollback_pkt = None
    video_pts = 0
    audio_pts = 0
    pat_pmt_counter = 0

    def emit(pid, pkt, kind):
        out.append({"pid": pid, "pkt": pkt, "kind": kind})

    video_frames = duration_ms // 40          # 25 fps
    for vf in range(video_frames):
        if pcr_rollback_frame is not None and vf == pcr_rollback_frame:
            pcr_27k -= 2 * CLOCK_27MHZ  # sudden 2 s backwards jump
        # PAT/PMT roughly every 100 ms -> every 2.5 video frames
        if pat_pmt_counter % 5 == 0:
            emit(PID_PAT, build_pat(builder), "pat")
            emit(PID_PMT, build_pmt(builder), "pmt")
        pat_pmt_counter += 1

        pes_v = pes_packet(0xE0, data_len=900, pts_90k=video_pts)
        video_pts += 3600  # 40 ms @ 90 kHz
        vp = split_pes(builder, PID_VIDEO, pes_v, pcr=pcr_27k)
        pcr_27k += 40 * 27_000  # 40 ms @ 27 MHz
        if pcr_rollback_frame is not None and vf == pcr_rollback_frame:
            rollback_pkt = vp[0]  # first packet carries rolled-back PCR

        # audio frames at ~21.3 ms intervals -> ~1.9 per video frame
        audio_here = []
        while audio_pts < video_pts:
            pes_a = pes_packet(0xC0, data_len=180, pts_90k=audio_pts)
            audio_pts += 1920  # 21.33 ms @ 90 kHz
            audio_here.append(split_pes(builder, PID_AUDIO, pes_a))

        # interleave: v0, a0, v1, a1, v2, v3, ...
        ai = 0
        for vi, pkt in enumerate(vp):
            emit(PID_VIDEO, pkt, "video")
            if ai < len(audio_here) and vi % 2 == 0:
                for ap in audio_here[ai]:
                    emit(PID_AUDIO, ap, "audio")
                ai += 1
        while ai < len(audio_here):
            for ap in audio_here[ai]:
                emit(PID_AUDIO, ap, "audio")
            ai += 1
    return out, rollback_pkt


def inject_faults(seq: list, mode: str) -> tuple:
    """Return (kept_packets, ground_truth) after fault injection.

    Ground truth records each dropped packet's *output* position (the index
    it would have had in the final stream) and PID.
    """
    drops = []  # indices into seq to drop
    if mode == "single-loss":
        # drop one video packet near the middle
        video_idx = [i for i, e in enumerate(seq) if e["kind"] == "video"]
        drops = [video_idx[len(video_idx) // 2]]
    elif mode == "burst-loss":
        # drop 4 consecutive video packets
        video_idx = [i for i, e in enumerate(seq) if e["kind"] == "video"]
        start = video_idx[len(video_idx) // 2]
        drops = list(range(start, start + 4))
    elif mode == "interleave":
        drops = []  # no fault: pure A/V interleaving
    elif mode == "pcr-rollback":
        drops = []  # no drops; PCR rollback injected during generation
    elif mode == "none":
        drops = []
    else:
        raise ValueError(f"unknown mode: {mode}")

    drop_set = set(drops)
    kept = []
    truth = []
    out_index = 0
    for i, entry in enumerate(seq):
        if i in drop_set:
            truth.append({
                "output_index": out_index,  # position where a gap appears
                "pid": entry["pid"],
                "kind": entry["kind"],
            })
            continue
        kept.append(entry)
        out_index += 1
    return kept, truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode",
                    choices=["single-loss", "burst-loss", "interleave",
                             "pcr-rollback", "none"])
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--truth", help="write ground-truth JSON here")
    ap.add_argument("--duration-ms", type=int, default=2000)
    args = ap.parse_args()

    rollback_frame = 25 if args.mode == "pcr-rollback" else None
    seq, rollback_pkt = generate(args.duration_ms, rollback_frame)
    kept, truth = inject_faults(seq, args.mode)
    with open(args.output, "wb") as fh:
        for entry in kept:
            fh.write(entry["pkt"])
    if args.truth:
        meta = {"mode": args.mode, "dropped": truth,
                "total_packets": len(kept)}
        if rollback_pkt is not None:
            for i, entry in enumerate(kept):
                if entry["pkt"] is rollback_pkt:
                    meta["pcr_rollback_at"] = {
                        "output_index": i, "pid": PID_VIDEO,
                        "backwards_ms": 2000.0}
                    break
        with open(args.truth, "w") as fh:
            json.dump(meta, fh, indent=2)
    print(f"{args.mode}: wrote {len(kept)} packets, "
          f"dropped {len(truth)} -> {args.output}")


if __name__ == "__main__":
    main()
