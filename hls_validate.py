#!/usr/bin/env python3
"""HLS 清单校验器：解析主清单与媒体清单，输出带行号的校验报告。"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field


@dataclass
class Issue:
    severity: str  # "ERROR" | "WARN"
    path: str
    line: int  # 1-based, 0 表示文件级问题
    message: str

    def __str__(self):
        loc = f"{self.path}:{self.line}" if self.line else self.path
        return f"[{self.severity}] {loc}: {self.message}"


@dataclass
class Segment:
    uri: str
    duration: float
    extinf_line: int
    uri_line: int
    index: int  # 媒体序列号


@dataclass
class MediaPlaylist:
    path: str
    target_duration: float = 0.0
    target_duration_line: int = 0
    media_sequence: int = 0
    media_sequence_line: int = 0
    playlist_type: str = ""
    map_uri: str = ""
    map_line: int = 0
    has_endlist: bool = False
    endlist_line: int = 0
    segments: list = field(default_factory=list)
    issues: list = field(default_factory=list)


@dataclass
class Variant:
    uri: str
    bandwidth: int
    resolution: str
    codecs: str
    inf_line: int
    uri_line: int
    media: MediaPlaylist = None


def read_lines(path):
    with open(path, "r", encoding="utf-8-sig") as fh:
        return fh.read().splitlines()


def parse_attrs(text):
    attrs = {}
    for m in re.finditer(r'([A-Z0-9-]+)=("([^"]*)"|[^,]*)', text):
        attrs[m.group(1)] = m.group(3) if m.group(3) is not None else m.group(2)
    return attrs


def parse_master(path):
    """解析主清单，返回 (variants, issues)。"""
    issues = []
    variants = []
    lines = read_lines(path)
    if not lines or lines[0].strip() != "#EXTM3U":
        issues.append(Issue("ERROR", path, 1, "缺少 #EXTM3U 文件头"))
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        lineno = i + 1
        if line.startswith("#EXT-X-STREAM-INF:"):
            attrs = parse_attrs(line.split(":", 1)[1])
            bw_raw = attrs.get("BANDWIDTH")
            if bw_raw is None:
                issues.append(Issue("ERROR", path, lineno,
                                    "EXT-X-STREAM-INF 缺少 BANDWIDTH 码率声明"))
                bandwidth = 0
            elif not bw_raw.isdigit() or int(bw_raw) <= 0:
                issues.append(Issue("ERROR", path, lineno,
                                    f"BANDWIDTH 非法: {bw_raw!r}（应为正整数）"))
                bandwidth = 0
            else:
                bandwidth = int(bw_raw)
            # 下一个非空行必须是变体 URI
            j = i + 1
            uri, uri_line = "", 0
            while j < len(lines):
                nxt = lines[j].strip()
                if not nxt:
                    j += 1
                    continue
                if nxt.startswith("#"):
                    issues.append(Issue("ERROR", path, lineno,
                                        "EXT-X-STREAM-INF 后缺少变体 URI 行"))
                else:
                    uri, uri_line = nxt, j + 1
                break
            else:
                issues.append(Issue("ERROR", path, lineno,
                                    "EXT-X-STREAM-INF 后缺少变体 URI 行"))
            variants.append(Variant(
                uri=uri, bandwidth=bandwidth,
                resolution=attrs.get("RESOLUTION", ""),
                codecs=attrs.get("CODECS", ""),
                inf_line=lineno, uri_line=uri_line))
            i = j + 1 if uri else i + 1
            continue
        i += 1
    if not variants:
        issues.append(Issue("ERROR", path, 0, "主清单中没有任何 EXT-X-STREAM-INF 变体"))
    return variants, issues


def parse_media(path):
    """解析媒体清单，返回带行号信息的 MediaPlaylist。"""
    mp = MediaPlaylist(path=path)
    lines = read_lines(path)
    if not lines or lines[0].strip() != "#EXTM3U":
        mp.issues.append(Issue("ERROR", path, 1, "缺少 #EXTM3U 文件头"))
    pending = None  # (duration, extinf_line)
    for idx, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-TARGETDURATION:"):
            mp.target_duration_line = idx
            try:
                mp.target_duration = float(line.split(":", 1)[1])
            except ValueError:
                mp.issues.append(Issue("ERROR", path, idx,
                                       f"EXT-X-TARGETDURATION 非法: {line!r}"))
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            mp.media_sequence_line = idx
            try:
                mp.media_sequence = int(line.split(":", 1)[1])
            except ValueError:
                mp.issues.append(Issue("ERROR", path, idx,
                                       f"EXT-X-MEDIA-SEQUENCE 非法: {line!r}"))
        elif line.startswith("#EXT-X-PLAYLIST-TYPE:"):
            mp.playlist_type = line.split(":", 1)[1].strip()
        elif line.startswith("#EXT-X-MAP:"):
            mp.map_line = idx
            mp.map_uri = parse_attrs(line.split(":", 1)[1]).get("URI", "")
            if not mp.map_uri:
                mp.issues.append(Issue("ERROR", path, idx,
                                       "EXT-X-MAP 缺少 URI 属性"))
        elif line.startswith("#EXTINF:"):
            dur_raw = line.split(":", 1)[1].split(",", 1)[0]
            try:
                pending = (float(dur_raw), idx)
            except ValueError:
                mp.issues.append(Issue("ERROR", path, idx,
                                       f"EXTINF 时长非法: {dur_raw!r}"))
                pending = None
        elif line.startswith("#EXT-X-ENDLIST"):
            mp.has_endlist = True
            mp.endlist_line = idx
        elif line.startswith("#EXT-X-DISCONTINUITY"):
            pass
        elif line.startswith("#"):
            continue
        else:
            if pending is None:
                mp.issues.append(Issue("ERROR", path, idx,
                                       f"分片 URI {line!r} 前缺少 EXTINF 时长行"))
                continue
            dur, extinf_line = pending
            seq = mp.media_sequence + len(mp.segments)
            mp.segments.append(Segment(uri=line, duration=dur,
                                       extinf_line=extinf_line,
                                       uri_line=idx, index=seq))
            pending = None
    if pending is not None:
        mp.issues.append(Issue("ERROR", path, pending[1],
                               "EXTINF 后缺少对应的分片 URI 行"))
    return mp


def check_media(mp, base_dir, probe_durations=None):
    """对媒体清单执行结构、目标时长、URI、MAP、ENDLIST 与连续性检查。"""
    if mp.target_duration_line == 0:
        mp.issues.append(Issue("ERROR", mp.path, 0,
                               "缺少 EXT-X-TARGETDURATION 标签"))
    if mp.media_sequence_line == 0:
        mp.issues.append(Issue("WARN", mp.path, 0,
                               "缺少 EXT-X-MEDIA-SEQUENCE 标签（按 0 处理）"))
    # 目标时长：每个 EXTINF 不得超过 TARGETDURATION（按 RFC 8216 四舍五入）
    if mp.target_duration > 0:
        for seg in mp.segments:
            if round(seg.duration) > mp.target_duration:
                mp.issues.append(Issue(
                    "ERROR", mp.path, seg.extinf_line,
                    f"分片 {seg.uri} 的 EXTINF {seg.duration:.3f}s 超过 "
                    f"TARGETDURATION {mp.target_duration:g}s（第 "
                    f"{mp.target_duration_line} 行声明）"))
    # 分片 URI：必须存在且非空
    for seg in mp.segments:
        seg_path = os.path.join(base_dir, seg.uri)
        if not os.path.isfile(seg_path):
            mp.issues.append(Issue(
                "ERROR", mp.path, seg.uri_line,
                f"分片文件缺失: {seg.uri}（媒体序列号 {seg.index}）"))
        elif os.path.getsize(seg_path) == 0:
            mp.issues.append(Issue(
                "ERROR", mp.path, seg.uri_line,
                f"分片文件为空: {seg.uri}"))
    # EXT-X-MAP 初始化段
    if mp.map_line:
        map_path = os.path.join(base_dir, mp.map_uri)
        if not os.path.isfile(map_path):
            mp.issues.append(Issue(
                "ERROR", mp.path, mp.map_line,
                f"EXT-X-MAP 初始化段缺失: {mp.map_uri}"))
    # ENDLIST：VOD 必须有
    if not mp.has_endlist:
        sev = "ERROR" if mp.playlist_type == "VOD" else "WARN"
        mp.issues.append(Issue(sev, mp.path, 0,
                               "缺少 EXT-X-ENDLIST（VOD 清单必须以 ENDLIST 结尾）"))
    # 实测时长交叉校验（可选，ffprobe 提供）
    if probe_durations:
        for seg in mp.segments:
            actual = probe_durations.get(seg.uri)
            if actual is None:
                continue
            if abs(actual - seg.duration) > 0.5:
                mp.issues.append(Issue(
                    "ERROR", mp.path, seg.extinf_line,
                    f"分片 {seg.uri} 声明时长 {seg.duration:.3f}s 与实测 "
                    f"{actual:.3f}s 不一致（偏差 {actual - seg.duration:+.3f}s）"))


def continuity_report(mp, base_dir):
    """返回 (是否连续, 说明)：序列号连续且所有分片文件齐全。"""
    if not mp.segments:
        return False, "没有任何分片"
    missing = [s for s in mp.segments
               if not os.path.isfile(os.path.join(base_dir, s.uri))]
    seqs = [s.index for s in mp.segments]
    gaps = [n for n in range(seqs[0], seqs[-1] + 1) if n not in seqs]
    if missing:
        return False, (f"缺失 {len(missing)} 个分片: "
                       + ", ".join(f"{s.uri}(序列号{s.index})" for s in missing))
    if gaps:
        return False, "媒体序列号不连续，缺号: " + ", ".join(map(str, gaps))
    return True, f"序列号 {seqs[0]}..{seqs[-1]} 连续，{len(seqs)} 个分片齐全"


def probe_segment_durations(mp, base_dir, ffprobe):
    """用 ffprobe 实测每个分片时长，返回 {uri: seconds}；失败返回 None。"""
    durations = {}
    init_path = (os.path.join(base_dir, mp.map_uri)
                 if mp.map_uri else None)
    for seg in mp.segments:
        seg_path = os.path.join(base_dir, seg.uri)
        if not os.path.isfile(seg_path):
            continue
        try:
            # fMP4 分片需拼接 EXT-X-MAP 初始化段才能解析
            with open(seg_path, "rb") as fh:
                payload = fh.read()
            if init_path and os.path.isfile(init_path):
                with open(init_path, "rb") as fh:
                    payload = fh.read() + payload
            out = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries",
                 "format=duration,start_time",
                 "-of", "default=noprint_wrappers=1", "pipe:0"],
                input=payload, capture_output=True, timeout=30)
            # fMP4 分片时间戳是累积的：实际长度 = 结束时刻 - 起始时刻
            fields = dict(line.split("=", 1) for line in
                          out.stdout.decode().splitlines() if "=" in line)
            end = float(fields["duration"])
            start = float(fields.get("start_time", 0) or 0)
            durations[seg.uri] = end - start
        except (ValueError, subprocess.SubprocessError):
            return None
    return durations


def check_bandwidth(variant, mp, base_dir):
    """码率声明检查：实测平均分片码率不应超过声明的 BANDWIDTH。"""
    if not variant.bandwidth:
        return
    worst, worst_seg = 0.0, None
    for seg in mp.segments:
        seg_path = os.path.join(base_dir, seg.uri)
        if not os.path.isfile(seg_path) or seg.duration <= 0:
            continue
        bitrate = os.path.getsize(seg_path) * 8 / seg.duration
        if bitrate > worst:
            worst, worst_seg = bitrate, seg
    if worst_seg is not None and worst > variant.bandwidth * 1.1:
        mp.issues.append(Issue(
            "WARN", mp.path, worst_seg.uri_line,
            f"分片 {worst_seg.uri} 实测码率 {worst / 1000:.0f}kbps 超出主清单第 "
            f"{variant.inf_line} 行声明的 BANDWIDTH={variant.bandwidth}"
            f"（{variant.bandwidth / 1000:.0f}kbps）"))


def validate_master(master_path, ffprobe=None):
    """完整校验主清单及其全部变体，返回 (variants, all_issues, summaries)。"""
    master_path = os.path.abspath(master_path)
    master_dir = os.path.dirname(master_path)
    variants, issues = parse_master(master_path)
    summaries = []
    for variant in variants:
        if not variant.uri:
            continue
        media_path = os.path.normpath(os.path.join(master_dir, variant.uri))
        if not os.path.isfile(media_path):
            issues.append(Issue("ERROR", master_path, variant.uri_line,
                                f"变体媒体清单不存在: {variant.uri}"))
            continue
        mp = parse_media(media_path)
        variant.media = mp
        media_dir = os.path.dirname(media_path)
        probed = (probe_segment_durations(mp, media_dir, ffprobe)
                  if ffprobe else None)
        check_media(mp, media_dir, probed)
        check_bandwidth(variant, mp, media_dir)
        ok, note = continuity_report(mp, media_dir)
        total = sum(s.duration for s in mp.segments)
        summaries.append({
            "variant": variant.uri,
            "bandwidth": variant.bandwidth,
            "resolution": variant.resolution,
            "segment_count": len(mp.segments),
            "total_duration": round(total, 3),
            "first_segment": mp.segments[0].uri if mp.segments else None,
            "last_segment": mp.segments[-1].uri if mp.segments else None,
            "media_sequence": mp.media_sequence,
            "continuous": ok,
            "continuity_note": note,
        })
        issues.extend(mp.issues)
    return variants, issues, summaries


def print_report(master_path, summaries, issues):
    print(f"== 主清单: {master_path} ==")
    for s in summaries:
        print(f"\n变体 {s['variant']}  "
              f"(BANDWIDTH={s['bandwidth']}, RESOLUTION={s['resolution'] or 'n/a'})")
        print(f"  分片数:     {s['segment_count']}"
              f"（媒体序列起始 {s['media_sequence']}）")
        print(f"  总时长:     {s['total_duration']:.3f}s")
        print(f"  首分片:     {s['first_segment']}")
        print(f"  尾分片:     {s['last_segment']}")
        print(f"  连续性:     {'OK' if s['continuous'] else 'FAIL'}"
              f" - {s['continuity_note']}")
    errors = [i for i in issues if i.severity == "ERROR"]
    warns = [i for i in issues if i.severity == "WARN"]
    print(f"\n== 校验结果: {len(errors)} 个错误, {len(warns)} 个警告 ==")
    for issue in sorted(issues, key=lambda i: (i.path, i.line)):
        print(f"  {issue}")
    return 1 if errors else 0


def simulate_fault(master_path, kind):
    """把演示目录复制到 fault_sim/<kind>/ 并注入一个故障，返回新主清单路径。"""
    src_dir = os.path.dirname(os.path.abspath(master_path))
    dst_dir = os.path.join(os.path.dirname(src_dir), "fault_sim", kind)
    if os.path.isdir(dst_dir):
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    new_master = os.path.join(dst_dir, os.path.basename(master_path))
    if kind == "missing-segment":
        victim = os.path.join(dst_dir, "seg_0_003.m4s")
        os.remove(victim)
        print(f"[模拟故障] 已删除分片: {victim}")
    elif kind == "duration-mismatch":
        media = os.path.join(dst_dir, "media_1.m3u8")
        lines = read_lines(media)
        for i, line in enumerate(lines):
            if line.startswith("#EXTINF:"):
                lines[i] = "#EXTINF:9.500000,"
                print(f"[模拟故障] 已把 {media} 第 {i + 1} 行改为 {lines[i]!r}"
                      f"（原分片实际约 2s）")
                break
        with open(media, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    else:
        raise SystemExit(f"未知故障类型: {kind}")
    return new_master


def main():
    ap = argparse.ArgumentParser(description="HLS 主清单/媒体清单校验器")
    ap.add_argument("master", help="主清单 m3u8 路径")
    ap.add_argument("--ffprobe", default=os.environ.get("FFPROBE"),
                    help="ffprobe 路径（提供时做分片实测时长交叉校验）")
    ap.add_argument("--simulate", choices=["missing-segment", "duration-mismatch"],
                    help="复制演示目录并注入一个故障后再校验")
    ap.add_argument("--json", dest="json_path",
                    help="把各变体汇总结果写成 JSON 文件")
    args = ap.parse_args()

    master = args.master
    if args.simulate:
        master = simulate_fault(master, args.simulate)

    _, issues, summaries = validate_master(master, ffprobe=args.ffprobe)
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump({"master": os.path.abspath(master),
                       "variants": summaries}, fh, ensure_ascii=False, indent=2)
    code = print_report(master, summaries, issues)
    if args.simulate and code == 0:
        print("!! 注入了故障但未检出，校验器存在问题 !!")
        return 2
    return code


if __name__ == "__main__":
    sys.exit(main())
