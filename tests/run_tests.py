#!/usr/bin/env python3
"""End-to-end tests for video_orient.py.

Covers horizontal, portrait and flip-bearing clips, the legacy rotate tag
and the duplicate-marker case, and asserts player-visible direction,
audio synchronization and container metadata after normalization.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

from mp4legacy import inject_legacy_rotate  # noqa: E402
from ppmsample import corners, pixel  # noqa: E402

FFMPEG = os.path.join(ROOT, "bin", "ffmpeg")
FFPROBE = os.path.join(ROOT, "bin", "ffprobe")
TOOL = [sys.executable, os.path.join(ROOT, "video_orient.py")]
WORK = os.path.join(ROOT, "artifacts", "test-work")

RED, GREEN, BLUE, YELLOW = (
    (253, 0, 0), (0, 127, 0), (0, 0, 254), (253, 253, 0),
)


def sh(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def ffprobe_json(path: str) -> dict:
    out = sh([FFPROBE, "-v", "error", "-show_format", "-show_streams",
              "-of", "json", path])
    return json.loads(out.stdout)


def video_stream(path: str) -> dict:
    for stream in ffprobe_json(path)["streams"]:
        if stream["codec_type"] == "video":
            return stream
    raise AssertionError("no video stream")


def extract_frame(path: str, name: str) -> str:
    target = os.path.join(WORK, name + ".ppm")
    sh([FFMPEG, "-y", "-i", path, "-vframes", "1", "-f", "image2",
        target, "-loglevel", "error"])
    return target


def inspect(path: str) -> dict:
    out = sh(TOOL + ["inspect", path, "--json"])
    return json.loads(out.stdout)


def normalize(src: str, dst: str) -> dict:
    sh(TOOL + ["normalize", src, dst, "--yes", "--preset", "ultrafast"])
    return inspect(dst)


class OrientationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.makedirs(WORK, exist_ok=True)
        marked = os.path.join(WORK, "marked.mp4")
        sh([
            FFMPEG, "-y",
            "-f", "lavfi", "-i",
            "color=c=gray:size=320x240:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-filter_complex",
            "[0:v]drawbox=x=0:y=0:w=40:h=40:color=red:t=fill,"
            "drawbox=x=280:y=0:w=40:h=40:color=green:t=fill,"
            "drawbox=x=0:y=200:w=40:h=40:color=blue:t=fill,"
            "drawbox=x=280:y=200:w=40:h=40:color=yellow:t=fill[v]",
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            marked, "-loglevel", "error",
        ])
        cls.marked = marked
        # Landscape-source clip carrying a 90 CCW matrix (displays portrait).
        cls.land_90 = os.path.join(WORK, "land_r90.mp4")
        sh([FFMPEG, "-y", "-display_rotation", "90", "-i", marked,
            "-c", "copy", cls.land_90, "-loglevel", "error"])
        # A genuinely portrait pixel source (240x320) with no matrix.
        cls.portrait_clean = os.path.join(WORK, "portrait_clean.mp4")
        sh([
            FFMPEG, "-y", "-f", "lavfi", "-i",
            "color=c=navy:size=240x320:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=660:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
            "yuv420p", "-c:a", "aac", "-shortest",
            cls.portrait_clean, "-loglevel", "error",
        ])
        # Portrait pixels plus a 90 CCW matrix: displays landscape.
        cls.port_r90 = os.path.join(WORK, "port_r90.mp4")
        sh([FFMPEG, "-y", "-display_rotation", "90",
            "-i", cls.portrait_clean, "-c", "copy", cls.port_r90,
            "-loglevel", "error"])
        # Flip-bearing matrix (vflip + 90).
        cls.flip90 = os.path.join(WORK, "flip_r90.mp4")
        sh([FFMPEG, "-y", "-display_rotation", "90", "-display_vflip",
            "-i", marked, "-c", "copy", cls.flip90, "-loglevel", "error"])
        # Legacy tag only and duplicate matrix+tag fixtures.
        cls.legacy = os.path.join(WORK, "legacy90.mp4")
        cls.duplicate = os.path.join(WORK, "dup90.mp4")
        inject_legacy_rotate(marked, cls.legacy, 90, reset_matrix=True)
        inject_legacy_rotate(cls.land_90, cls.duplicate, 90,
                             reset_matrix=False)

    def test_01_inspect_distinguishes_pixels_from_display(self) -> None:
        report = inspect(self.land_90)
        self.assertEqual(report["decoded_pixels"],
                         {"width": 320, "height": 240})
        self.assertEqual(report["display"],
                         {"width": 240, "height": 320})
        self.assertEqual(report["orientation"]["rotation"], 90)
        self.assertEqual(report["marker_sources"], ["display_matrix"])
        self.assertTrue(report["needs_normalization"])
        clean = inspect(self.portrait_clean)
        self.assertEqual(clean["decoded_pixels"],
                         {"width": 240, "height": 320})
        self.assertEqual(clean["display"],
                         {"width": 240, "height": 320})
        self.assertEqual(clean["marker_sources"], [])
        self.assertFalse(clean["needs_normalization"])

    def test_02_duplicate_markers_detected(self) -> None:
        report = inspect(self.duplicate)
        self.assertIn("display_matrix", report["marker_sources"])
        self.assertIn("legacy_rotate_tag", report["marker_sources"])
        self.assertTrue(report["duplicate_markers"])
        legacy = inspect(self.legacy)
        self.assertEqual(legacy["marker_sources"],
                         ["legacy_rotate_tag"])
        self.assertEqual(legacy["legacy_rotate_tag"], "90")

    def test_03_landscape_matrix_bakes_player_direction(self) -> None:
        out = os.path.join(WORK, "land_r90_out.mp4")
        report = normalize(self.land_90, out)
        self.assertEqual(report["decoded_pixels"],
                         {"width": 240, "height": 320})
        frame = extract_frame(out, "land_r90_out")
        marks = corners(frame)
        # 90 CCW: original TR (green) moves to TL, TL (red) to BL, etc.
        self.assertEqual(marks["TL"], GREEN)
        self.assertEqual(marks["BL"], RED)
        self.assertEqual(marks["TR"], YELLOW)
        self.assertEqual(marks["BR"], BLUE)

    def test_04_portrait_clip_returns_to_landscape(self) -> None:
        out = os.path.join(WORK, "port_r90_out.mp4")
        report = normalize(self.port_r90, out)
        self.assertEqual(report["decoded_pixels"],
                         {"width": 320, "height": 240})
        self.assertEqual(report["display"],
                         {"width": 320, "height": 240})

    def test_05_flip_matrix_direction(self) -> None:
        out = os.path.join(WORK, "flip_out.mp4")
        normalize(self.flip90, out)
        frame = extract_frame(out, "flip_out")
        marks = corners(frame)
        # Reference produced by ffmpeg's own autorotate on the same input.
        reference = os.path.join(WORK, "flip_ref.mp4")
        sh([FFMPEG, "-y", "-i", self.flip90, "-c:v", "libx264",
            "-preset", "ultrafast", "-crf", "0", "-an", reference,
            "-loglevel", "error"])
        ref_marks = corners(extract_frame(reference, "flip_ref"))
        self.assertEqual(marks, ref_marks)
        self.assertNotEqual(marks, corners(
            extract_frame(self.land_90, "flip_land90")))

    def test_06_legacy_tag_rotated_once(self) -> None:
        out = os.path.join(WORK, "legacy_out.mp4")
        report = normalize(self.legacy, out)
        self.assertEqual(report["decoded_pixels"],
                         {"width": 240, "height": 320})
        self.assertEqual(corners(extract_frame(out, "legacy_out"))["TL"],
                         GREEN)

    def test_07_duplicate_markers_collapse_to_none(self) -> None:
        out = os.path.join(WORK, "dup_out.mp4")
        report = normalize(self.duplicate, out)
        self.assertEqual(report["marker_sources"], [])
        self.assertIsNone(report["legacy_rotate_tag"])
        stream = video_stream(out)
        self.assertNotIn("side_data_list", stream)
        self.assertEqual((stream["width"], stream["height"]), (240, 320))

    def test_08_no_second_rotation_on_reprocess(self) -> None:
        once = os.path.join(WORK, "once.mp4")
        twice = os.path.join(WORK, "twice.mp4")
        normalize(self.land_90, once)
        second = normalize(once, twice) if inspect(once)["needs_normalization"] \
            else None
        self.assertIsNone(second)
        self.assertEqual(video_stream(once)["width"], 240)
        self.assertEqual(video_stream(once)["height"], 320)

    def test_09_audio_stays_in_sync(self) -> None:
        out = os.path.join(WORK, "audio_out.mp4")
        normalize(self.land_90, out)
        before = ffprobe_json(self.land_90)
        after = ffprobe_json(out)
        a_before = next(s for s in before["streams"]
                        if s["codec_type"] == "audio")
        a_after = next(s for s in after["streams"]
                       if s["codec_type"] == "audio")
        self.assertEqual(a_before["codec_name"], a_after["codec_name"])
        self.assertAlmostEqual(float(a_before["duration"]),
                               float(a_after["duration"]), delta=0.05)
        v_after = next(s for s in after["streams"]
                       if s["codec_type"] == "video")
        self.assertAlmostEqual(float(v_after["duration"]),
                               float(a_after["duration"]), delta=0.08)
        # With -c:a copy the decoded waveform must be byte-for-byte identical
        # and keep the same packet timestamps, ruling out A/V drift.
        before_wav = os.path.join(WORK, "before.wav")
        after_wav = os.path.join(WORK, "after.wav")
        for src, dst in ((self.land_90, before_wav), (out, after_wav)):
            sh([FFMPEG, "-y", "-i", src, "-vn", "-ac", "1",
                "-f", "wav", dst, "-loglevel", "error"])
        with open(before_wav, "rb") as handle:
            before_pcm = handle.read()
        with open(after_wav, "rb") as handle:
            after_pcm = handle.read()
        self.assertEqual(before_pcm, after_pcm)
        before_pts = sh([FFPROBE, "-v", "error", "-select_streams", "a",
                         "-show_entries", "packet=pts_time",
                         "-of", "csv=p=0", self.land_90]).stdout
        after_pts = sh([FFPROBE, "-v", "error", "-select_streams", "a",
                        "-show_entries", "packet=pts_time",
                        "-of", "csv=p=0", out]).stdout
        self.assertEqual(before_pts, after_pts)

    def test_10_all_eight_orientations(self) -> None:
        # One input per unique 2x2 matrix (other rotation+flip combos are
        # mathematically equivalent). Corner layouts were captured from
        # ffmpeg's own autorotate output on the same fixture.
        cases = [
            # rotation, hflip, vflip, expected corners after baking
            (0, False, False, {"TL": RED, "TR": GREEN, "BL": BLUE,
                                "BR": YELLOW}),
            (90, False, False, {"TL": GREEN, "TR": YELLOW, "BL": RED,
                                 "BR": BLUE}),
            (180, False, False, {"TL": YELLOW, "TR": BLUE, "BL": GREEN,
                                  "BR": RED}),
            (270, False, False, {"TL": BLUE, "TR": RED, "BL": YELLOW,
                                  "BR": GREEN}),
            (0, True, False, {"TL": GREEN, "TR": RED, "BL": YELLOW,
                               "BR": BLUE}),
            (0, False, True, {"TL": BLUE, "TR": YELLOW, "BL": RED,
                               "BR": GREEN}),
            (90, True, False, {"TL": YELLOW, "TR": GREEN, "BL": BLUE,
                                "BR": RED}),
            (90, False, True, {"TL": RED, "TR": BLUE, "BL": GREEN,
                                "BR": YELLOW}),
        ]
        for index, (rotation, hflip, vflip, expected) in enumerate(cases):
            with self.subTest(rotation=rotation, hflip=hflip, vflip=vflip):
                source = os.path.join(WORK, f"all_{index}.mp4")
                cmd = [FFMPEG, "-y"]
                if rotation:
                    cmd += ["-display_rotation", str(rotation)]
                if hflip:
                    cmd += ["-display_hflip"]
                if vflip:
                    cmd += ["-display_vflip"]
                cmd += ["-i", self.marked, "-c", "copy", source,
                        "-loglevel", "error"]
                sh(cmd)
                report = inspect(source)
                orient = report["orientation"]
                if rotation == 0 and not hflip and not vflip:
                    self.assertTrue(orient["identity"])
                    self.assertFalse(report["needs_normalization"])
                    continue
                self.assertFalse(orient["identity"])
                out = os.path.join(WORK, f"all_{index}_out.mp4")
                normalized = normalize(source, out)
                self.assertEqual(normalized["marker_sources"], [])
                frame = extract_frame(out, f"all_{index}_out")
                self.assertEqual(corners(frame), expected)
                stream = video_stream(out)
                if rotation in (90, 270):
                    self.assertEqual((stream["width"], stream["height"]),
                                     (240, 320))
                else:
                    self.assertEqual((stream["width"], stream["height"]),
                                     (320, 240))


if __name__ == "__main__":
    unittest.main(verbosity=2)
