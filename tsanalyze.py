#!/usr/bin/env python3
"""MPEG-TS stream analyzer.

Checks per-PID continuity counters, parses PAT/PMT, extracts PCR values
and flags PCR rollback separately. A/V interleaving is handled correctly
because continuity is tracked per PID, never across the whole stream.

Outputs a JSON report and a self-contained HTML report with a per-PID
timeline and anomaly statistics.
"""
import argparse
import json
import struct

TS_PACKET_SIZE = 188
SYNC_BYTE = 0x47

# PCR rollback threshold: a backwards jump larger than this (in 27 MHz
# ticks, default 500 ms) is flagged as an anomaly. Small backwards jitter
# below the threshold is ignored.
PCR_ROLLBACK_THRESHOLD = 27_000_000 // 2


def parse_pcr(adaptation: bytes):
    """Extract PCR (27 MHz ticks) from an adaptation field, or None."""
    if len(adaptation) < 7:
        return None
    flags = adaptation[0]
    if not (flags & 0x10):
        return None
    b = adaptation[1:7]
    base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
    ext = ((b[4] & 0x01) << 8) | b[5]
    return base * 300 + ext


def parse_pat(payload: bytes) -> list:
    """Parse a PAT section payload (starting at pointer_field)."""
    programs = []
    if not payload:
        return programs
    pointer = payload[0]
    pos = 1 + pointer
    if pos + 8 > len(payload) or payload[pos] != 0x00:
        return programs
    section_length = ((payload[pos + 1] & 0x0F) << 8) | payload[pos + 2]
    end = pos + 3 + section_length - 4  # exclude CRC
    i = pos + 8  # skip table_id..last_section_number
    while i + 4 <= end:
        program_number = (payload[i] << 8) | payload[i + 1]
        pid = ((payload[i + 2] & 0x1F) << 8) | payload[i + 3]
        if program_number != 0:
            programs.append({"program": program_number, "pmt_pid": pid})
        i += 4
    return programs


def parse_pmt(payload: bytes) -> dict:
    """Parse a PMT section payload; returns PCR PID and stream list."""
    info = {"pcr_pid": None, "streams": []}
    if not payload:
        return info
    pointer = payload[0]
    pos = 1 + pointer
    if pos + 12 > len(payload) or payload[pos] != 0x02:
        return info
    section_length = ((payload[pos + 1] & 0x0F) << 8) | payload[pos + 2]
    end = pos + 3 + section_length - 4
    info["pcr_pid"] = ((payload[pos + 8] & 0x1F) << 8) | payload[pos + 9]
    prog_info_len = ((payload[pos + 10] & 0x0F) << 8) | payload[pos + 11]
    i = pos + 12 + prog_info_len
    while i + 5 <= end:
        stream_type = payload[i]
        elem_pid = ((payload[i + 1] & 0x1F) << 8) | payload[i + 2]
        es_info_len = ((payload[i + 3] & 0x0F) << 8) | payload[i + 4]
        info["streams"].append({"stream_type": stream_type, "pid": elem_pid})
        i += 5 + es_info_len
    return info


class PidState:
    def __init__(self, pid: int):
        self.pid = pid
        self.packet_count = 0
        self.last_cc = None
        self.last_pcr = None
        self.pcr_values = []          # (packet_index, pcr_27mhz)
        self.cc_errors = []           # loss events
        self.pcr_rollbacks = []       # rollback events
        self.discontinuities_ok = 0   # signalled discontinuities (not errors)


def analyze(path: str) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) % TS_PACKET_SIZE != 0:
        raise ValueError("file size is not a multiple of 188 bytes")

    pids = {}
    pat_programs = []
    pmt_info = {}
    sync_errors = []
    total = len(data) // TS_PACKET_SIZE

    def state_for(pid):
        if pid not in pids:
            pids[pid] = PidState(pid)
        return pids[pid]

    for index in range(total):
        pkt = data[index * TS_PACKET_SIZE:(index + 1) * TS_PACKET_SIZE]
        if pkt[0] != SYNC_BYTE:
            sync_errors.append(index)
            continue
        pusi = bool(pkt[1] & 0x40)
        pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
        afc = (pkt[3] >> 4) & 0x3
        cc = pkt[3] & 0x0F
        st = state_for(pid)
        st.packet_count += 1

        offset = 4
        adaptation = b""
        discontinuity_flag = False
        if afc in (0x2, 0x3):  # adaptation field present
            afl = pkt[4]
            if afl > 0 and 5 + afl <= TS_PACKET_SIZE:
                adaptation = pkt[5:5 + afl]
                discontinuity_flag = bool(adaptation[0] & 0x80)
                pcr = parse_pcr(adaptation)
                if pcr is not None:
                    st.pcr_values.append((index, pcr))
                    if (st.last_pcr is not None
                            and pcr < st.last_pcr
                            and st.last_pcr - pcr > PCR_ROLLBACK_THRESHOLD):
                        st.pcr_rollbacks.append({
                            "packet_index": index,
                            "previous_pcr": st.last_pcr,
                            "pcr": pcr,
                            "backwards_ms": (st.last_pcr - pcr) / 27_000,
                        })
                    st.last_pcr = pcr
            offset = 5 + afl

        # --- continuity counter check (per PID) ---
        has_payload = afc in (0x1, 0x3)
        if has_payload:
            if st.last_cc is not None:
                expected = (st.last_cc + 1) & 0xF
                if cc != expected:
                    if discontinuity_flag:
                        # encoder signalled a legal discontinuity
                        st.discontinuities_ok += 1
                    else:
                        lost = (cc - expected) & 0xF
                        st.cc_errors.append({
                            "packet_index": index,
                            "expected_cc": expected,
                            "received_cc": cc,
                            "lost_packets": lost,
                        })
            st.last_cc = cc
        # adaptation-field-only packets do not advance the CC

        # --- PSI parsing ---
        if pusi and offset < TS_PACKET_SIZE:
            payload = pkt[offset:]
            if pid == 0x0000:
                pat_programs.extend(parse_pat(payload))
            elif any(p["pmt_pid"] == pid for p in pat_programs) or pid in pmt_info:
                pmt_info[pid] = parse_pmt(payload)

    return {
        "file": path,
        "total_packets": total,
        "sync_errors": sync_errors,
        "pat": pat_programs,
        "pmt": {str(k): v for k, v in pmt_info.items()},
        "pids": {
            str(pid): {
                "packet_count": st.packet_count,
                "cc_errors": st.cc_errors,
                "pcr_rollbacks": st.pcr_rollbacks,
                "pcr_values": st.pcr_values,
                "signalled_discontinuities": st.discontinuities_ok,
            }
            for pid, st in sorted(pids.items())
        },
    }


def render_html(report: dict, template_path: str) -> str:
    with open(template_path, "r", encoding="utf-8") as fh:
        template = fh.read()
    payload = json.dumps(report)
    return template.replace("/*__REPORT_DATA__*/", payload)


def print_summary(report: dict):
    print(f"file: {report['file']}  packets: {report['total_packets']}")
    if report["sync_errors"]:
        print(f"  SYNC ERRORS at packets: {report['sync_errors']}")
    for prog in report["pat"]:
        print(f"  PAT: program {prog['program']} -> PMT PID 0x{prog['pmt_pid']:04x}")
    for pid_str, pmt in report["pmt"].items():
        streams = ", ".join(
            f"0x{s['pid']:04x}(type 0x{s['stream_type']:02x})"
            for s in pmt["streams"])
        print(f"  PMT 0x{int(pid_str):04x}: PCR_PID=0x{pmt['pcr_pid']:04x} "
              f"streams: {streams}")
    for pid_str, info in report["pids"].items():
        pid = int(pid_str)
        cc_errs = info["cc_errors"]
        rollbacks = info["pcr_rollbacks"]
        print(f"  PID 0x{pid:04x}: {info['packet_count']} packets, "
              f"{len(cc_errs)} CC error(s), {len(rollbacks)} PCR rollback(s)")
        for err in cc_errs:
            print(f"    LOSS @packet {err['packet_index']}: "
                  f"expected CC {err['expected_cc']}, got {err['received_cc']} "
                  f"({err['lost_packets']} packet(s) lost)")
        for rb in rollbacks:
            print(f"    PCR ROLLBACK @packet {rb['packet_index']}: "
                  f"{rb['previous_pcr']} -> {rb['pcr']} "
                  f"(-{rb['backwards_ms']:.1f} ms)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--json", help="write JSON report here")
    ap.add_argument("--html", help="write HTML report here")
    ap.add_argument("--template", default="report_template.html")
    args = ap.parse_args()

    report = analyze(args.input)
    print_summary(report)
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=2)
    if args.html:
        html = render_html(report, args.template)
        with open(args.html, "w", encoding="utf-8") as fh:
            fh.write(html)
        print(f"HTML report -> {args.html}")


if __name__ == "__main__":
    main()
