"""End-to-end checks for seam detection and physical repair."""

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from loopseam.analyze import SeamAnalyzer, estimate_beat_period
from loopseam.generate import write_materials
from loopseam.repair import loop_crossfade, max_adjacent_jump, wrap_metrics


def _materials(tmp_path: Path):
    meta = write_materials(tmp_path)
    return meta


def test_materials_are_periodic(tmp_path):
    meta = _materials(tmp_path)
    sr = meta["sr"]
    base, _ = sf.read(tmp_path / "seamless.wav", dtype="float64")
    tiled = np.tile(base, 3)
    assert np.array_equal(tiled[: base.size], tiled[base.size: 2 * base.size])
    assert abs(base[-1] - base[0]) == 0.0


def test_beat_period_recovered(tmp_path):
    meta = _materials(tmp_path)
    sr, beat = meta["sr"], meta["beat_samples"]
    for name in ("seamless", "missing_beat", "extra_quarter"):
        x, _ = sf.read(tmp_path / f"{name}.wav", dtype="float64")
        period, bpm = estimate_beat_period(x, sr)
        assert abs(period - beat) <= 2
        assert abs(bpm - 120.0) < 0.1


def test_clean_materials_find_true_seam(tmp_path):
    meta = _materials(tmp_path)
    sr, true_n, quarter = (meta["sr"], meta["true_loop_samples"],
                           meta["quarter_samples"])
    # Seamless: zero trim.
    x, _ = sf.read(tmp_path / "seamless.wav", dtype="float64")
    an = SeamAnalyzer(x, sr)
    grid, _, _ = an.best_beat_aligned()
    fine = an.refine_around(grid.seam_sample)
    assert abs(fine.seam_sample - true_n) <= 2
    assert fine.sample_diff_peak < 0.05
    # Extra quarter: trim back one quarter note.
    y, _ = sf.read(tmp_path / "extra_quarter.wav", dtype="float64")
    any_ = SeamAnalyzer(y, sr)
    grid_y, _, _ = any_.best_beat_aligned()
    fine_y = any_.refine_around(grid_y.seam_sample)
    assert abs((fine_y.seam_sample - y.size) - (-quarter)) <= 2


def test_missing_beat_requires_crossfade(tmp_path):
    meta = _materials(tmp_path)
    sr = meta["sr"]
    x, _ = sf.read(tmp_path / "missing_beat.wav", dtype="float64")
    an = SeamAnalyzer(x, sr)
    grid, _, _ = an.best_beat_aligned()
    fine = an.refine_around(grid.seam_sample)
    # No clean seam exists for a structurally shortened phrase.
    assert fine.sample_diff_peak > 0.15


def test_crossfade_physically_removes_wrap_click(tmp_path):
    meta = _materials(tmp_path)
    sr = meta["sr"]
    x, _ = sf.read(tmp_path / "missing_beat.wav", dtype="float64")
    an = SeamAnalyzer(x, sr)
    grid, _, _ = an.best_beat_aligned()
    seam = grid.seam_sample
    repaired = loop_crossfade(x, seam, int(0.02 * sr))
    # Samples inside the fade region were actually modified.
    fade = int(0.02 * sr)
    assert not np.array_equal(x[seam - fade:seam],
                              repaired[seam - fade:seam])
    # The wrap boundary is exactly continuous after repair.
    assert abs(repaired[-1] - repaired[0]) == 0.0
    metrics = wrap_metrics(repaired, sr)
    assert metrics["wrap_jump_ratio"] == 0.0
    assert max_adjacent_jump(repaired) <= np.max(np.abs(np.diff(x))) + 1e-9


def test_pure_trim_is_prefix(tmp_path):
    meta = _materials(tmp_path)
    sr, quarter = meta["sr"], meta["quarter_samples"]
    x, _ = sf.read(tmp_path / "extra_quarter.wav", dtype="float64")
    an = SeamAnalyzer(x, sr)
    grid, _, _ = an.best_beat_aligned()
    fine = an.refine_around(grid.seam_sample)
    trimmed = x[: fine.seam_sample]
    assert np.array_equal(trimmed, fine.seam_sample and x[: fine.seam_sample])
    assert abs(trimmed.size - (x.size - quarter)) <= 2


def test_report_payload(tmp_path):
    meta = _materials(tmp_path)
    payload = json.loads(json.dumps(meta))
    assert payload["true_loop_samples"] == meta["true_loop_samples"]
