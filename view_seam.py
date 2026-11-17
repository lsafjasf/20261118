"""Launch the interactive seam viewer for one WAV file.

Examples
--------
python view_seam.py artifacts/materials/extra_quarter.wav --seam 176400

Without a GUI backend the script writes a headless snapshot instead.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import soundfile as sf

from loopseam.analyze import SeamAnalyzer
from loopseam.viewer import SeamViewer, headless_snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--seam", type=int, default=None,
                        help="initial seam sample (default: auto-detected)")
    parser.add_argument("--fade-ms", type=float, default=20.0)
    parser.add_argument("--snapshot", type=Path, default=None,
                        help="write a PNG and exit without opening a window")
    args = parser.parse_args()

    x, sr = sf.read(args.wav, dtype="float64")
    if args.seam is None:
        grid, _, _ = SeamAnalyzer(x, sr).best_beat_aligned()
        seam = grid.seam_sample
    else:
        seam = args.seam

    if args.snapshot is not None:
        headless_snapshot(args.wav, sr, seam, args.snapshot,
                          fade_ms=args.fade_ms)
        print(f"wrote {args.snapshot}")
        return
    viewer = SeamViewer(args.wav, sr, seam, fade_ms=args.fade_ms)
    viewer.show()


if __name__ == "__main__":
    main()
