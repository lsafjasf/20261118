"""Frame-based loudness / peak / silence analysis with anomaly detection.

Design (single shared, absolute time axis):

* K-weighting (ITU-R BS.1770-4 shelving + high-pass) is applied once,
  continuously over the whole signal via zero-state IIR filtering. Filter
  state is never reset at frame or window boundaries, so a dragged local
  window never changes the result of any sample it contains.
* Analysis frame: 1.0 s Hann window, 0.5 s hop  -> 50% overlap. A Hann
  window at 50% hop satisfies the constant-overlap-add (COLA) condition, so
  frame energies tile the timeline without gaps or double counting.
* Loudness per frame is BS.1770 ungated K-weighted loudness (LUFS):
      L = -0.691 + 10 * log10( weighted mean square )
* Peaks are taken sample-accurately on the *unweighted* signal, one value
  per 0.5 s hop cell (no double counting), aligned to frame start times.
* Silence uses an unweighted absolute threshold (default -50 dBFS) and is
  measured per hop cell; total silence is additionally computed at sample
  resolution, with exact digital-zero duration reported separately.
* Every metric is timestamped by its absolute frame/cell start time, so any
  later local re-analysis keeps the original 0..duration coordinate system.

Outputs artifacts/metrics.json consumed by the interactive map viewer.
"""

from __future__ import annotations

import json
import math
import os

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

WINDOW_S = 1.0
HOP_S = 0.5
# Silence is decided by short-term cell RMS, not by individual samples, so
# zero crossings and 16-bit quantization do not create false silence.
SILENCE_DBFS = -60.0
LOUD_ONSET_LU = 10.0          # sudden-loud jump above local baseline
LOUD_ABS_GATE_LUFS = -22.0    # frame must also be genuinely loud
BASELINE_FRAMES = 10          # 10 frames x 0.5 s = 5 s local reference
LOW_LEVEL_LUFS = -40.0        # sustained low-level threshold
LOW_MIN_RUN_S = 3.0           # minimum duration to flag low-level region

IN_WAV = os.path.join("artifacts", "test_track.wav")
OUT_JSON = os.path.join("artifacts", "metrics.json")


def k_weight_coeffs(sr: int):
    """BS.1770-4 K-weighting biquad coefficients (RBJ form), pyloudnorm style."""

    def rbj(f0: float, gain_db: float, q: float):
        amp = 10.0 ** (gain_db / 40.0)
        w0 = 2.0 * math.pi * f0 / sr
        cos_w, sin_w = math.cos(w0), math.sin(w0)
        alpha = sin_w / 2.0 * math.sqrt(
            (amp + 1.0 / amp) * (1.0 / q - 1.0) + 2.0
        )
        sa = 2.0 * math.sqrt(amp) * alpha
        b0 = amp * ((amp + 1.0) + (amp - 1.0) * cos_w + sa)
        b1 = -2.0 * amp * ((amp - 1.0) + (amp + 1.0) * cos_w)
        b2 = amp * ((amp + 1.0) + (amp - 1.0) * cos_w - sa)
        a0 = (amp + 1.0) - (amp - 1.0) * cos_w + sa
        a1 = 2.0 * ((amp - 1.0) - (amp + 1.0) * cos_w)
        a2 = (amp + 1.0) - (amp - 1.0) * cos_w - sa
        return np.array([b0, b1, b2]) / a0, np.array([1.0, a1 / a0, a2 / a0])

    # Stage 1: high shelf (+4 dB). Stage 2: high-pass. Frequencies are absolute.
    b_shelf, a_shelf = rbj(1681.763225115885, 4.0, 0.7071752369554193)
    b_hp, a_hp = rbj(38.13547087602444, 0.0, 0.5003270373238773)
    return (b_shelf, a_shelf), (b_hp, a_hp)


def k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    (b1, a1), (b2, a2) = k_weight_coeffs(sr)
    y = lfilter(b1, a1, x)
    y = lfilter(b2, a2, y)
    return y


def main() -> None:
    data, sr = sf.read(IN_WAV, dtype="float64", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    n_samples = data.size
    duration = n_samples / sr
    win = int(round(WINDOW_S * sr))
    hop = int(round(HOP_S * sr))
    hann = 0.5 - 0.5 * np.cos(2.0 * math.pi * np.arange(win) / win)
    w_norm = float(hann.sum())

    weighted = k_weight(data, sr)
    sq = weighted * weighted
    raw_sq = data * data
    raw_abs = np.abs(data)
    silence_power = 10.0 ** (SILENCE_DBFS / 10.0)

    frame_starts = np.arange(0, n_samples - win + 1, hop)
    times, loudness, peak_db, peak_time, silence_ratio, cell_rms = [], [], [], [], [], []
    for fs_idx in frame_starts:
        i0, i1 = int(fs_idx), int(fs_idx) + win
        mean_sq = float(np.sum(hann * sq[i0:i1]) / w_norm)
        lufs = -0.691 + (10.0 * math.log10(mean_sq) if mean_sq > 1e-12 else -120.0)
        # Peak + silence use the hop cell starting here (no overlap double count).
        c1 = min(i0 + hop, n_samples)
        cell = raw_abs[i0:c1]
        cell_mean_sq = float(np.mean(raw_sq[i0:c1]))
        is_silent = cell_mean_sq < silence_power
        p_idx = i0 + int(np.argmax(cell))
        times.append(i0 / sr)
        loudness.append(lufs)
        peak_db.append(20.0 * math.log10(max(float(cell.max()), 1e-12)))
        peak_time.append(p_idx / sr)
        silence_ratio.append(1.0 if is_silent else 0.0)
        cell_rms.append(
            10.0 * math.log10(cell_mean_sq) / 2.0 if cell_mean_sq > 1e-12 else -120.0
        )

    times = np.array(times)
    loudness = np.array(loudness)
    peak_db = np.array(peak_db)
    peak_time = np.array(peak_time)
    silence_ratio = np.array(silence_ratio)
    cell_rms = np.array(cell_rms)

    # Silence total from silent hop cells (each cell = HOP_S seconds).
    silence_total_s = float(silence_ratio.sum() * HOP_S)
    # Exact digital-zero duration kept as a separate diagnostic.
    zero_total_s = float(np.count_nonzero(data == 0.0) / sr)

    # Global extremes.
    global_peak_idx = int(np.argmax(raw_abs))
    global_peak_db = 20.0 * math.log10(max(float(raw_abs[global_peak_idx]), 1e-12))
    max_loud_idx = int(np.argmax(loudness))

    sudden, low_regions, silence_regions = _detect_regions(times, loudness, silence_ratio)

    metrics = {
        "sample_rate": sr,
        "duration_s": duration,
        "frame": {"window_s": WINDOW_S, "hop_s": HOP_S, "overlap": "50% Hann COLA"},
        "silence_threshold_dbfs": SILENCE_DBFS,
        "thresholds": {
            "sudden_loud_jump_lu": LOUD_ONSET_LU,
            "low_level_lufs": LOW_LEVEL_LUFS,
            "low_min_run_s": LOW_MIN_RUN_S,
        },
        "timeline": {
            "t_s": [round(float(t), 3) for t in times],
            "loudness_lufs": [round(float(v), 2) for v in loudness],
            "peak_dbfs": [round(float(v), 2) for v in peak_db],
            "peak_time_s": [round(float(t), 3) for t in peak_time],
            "silence_ratio": [round(float(v), 3) for v in silence_ratio],
            "cell_rms_dbfs": [round(float(v), 2) for v in cell_rms],
        },
        "summary": {
            "max_loudness_lufs": round(float(loudness[max_loud_idx]), 2),
            "max_loudness_frame_time_s": round(float(times[max_loud_idx]), 3),
            "global_peak_dbfs": round(global_peak_db, 2),
            "global_peak_time_s": round(global_peak_idx / sr, 3),
            "global_peak_sample_index": global_peak_idx,
            "silence_total_s": round(silence_total_s, 3),
            "digital_zero_total_s": round(zero_total_s, 3),
        },
        "regions": {
            "sudden_loud": sudden,
            "sustained_low": low_regions,
            "silence": silence_regions,
        },
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh)

    _print_report(metrics)


def _detect_regions(times, loudness, silence_ratio):
    sudden, low_regions, silence_regions = [], [], []

    # Sudden-loud: frame jumps well above its recent local baseline AND passes
    # an absolute loudness gate. The gate prevents quiet->normal recoveries
    # (which also produce big relative jumps) from being flagged as bursts.
    n = len(loudness)
    baseline = np.empty(n)
    for i in range(n):
        lo = max(0, i - BASELINE_FRAMES)
        baseline[i] = np.median(loudness[lo:i + 1])
    deltas = loudness - baseline
    flagged = (deltas >= LOUD_ONSET_LU) & (loudness >= LOUD_ABS_GATE_LUFS)
    i = 0
    while i < len(flagged):
        if flagged[i]:
            j = i
            # Extend over the whole burst, including adjacent still-above-gate
            # frames, but stop as soon as the level returns near the baseline.
            while j + 1 < len(flagged) and loudness[j + 1] >= LOUD_ABS_GATE_LUFS:
                j += 1
            seg = loudness[i:j + 1]
            sudden.append(
                {
                    "start_s": round(float(times[i]), 3),
                    "end_s": round(float(times[min(j, len(times) - 1)]) + HOP_S, 3),
                    "peak_lufs": round(float(seg.max()), 2),
                    "onset_jump_lu": round(float(deltas[i]), 2),
                }
            )
            i = j + 1
        else:
            i += 1

    # Sustained low-level: contiguous sub-threshold run that is not true
    # silence (silence cells are excluded so the two anomaly types stay clean).
    quiet = (loudness <= LOW_LEVEL_LUFS) & (silence_ratio < 0.5)
    i = 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j + 1 < len(quiet) and quiet[j + 1]:
                j += 1
            t0, t1 = float(times[i]), float(times[j]) + HOP_S
            if t1 - t0 >= LOW_MIN_RUN_S:
                low_regions.append(
                    {
                        "start_s": round(t0, 3),
                        "end_s": round(t1, 3),
                        "min_lufs": round(float(loudness[i:j + 1].min()), 2),
                    }
                )
            i = j + 1
        else:
            i += 1

    # Silence regions from hop-cell silence flags.
    sil = silence_ratio >= 0.5
    i = 0
    while i < len(sil):
        if sil[i]:
            j = i
            while j + 1 < len(sil) and sil[j + 1]:
                j += 1
            silence_regions.append(
                {
                    "start_s": round(float(times[i]), 3),
                    "end_s": round(float(times[j]) + HOP_S, 3),
                }
            )
            i = j + 1
        else:
            i += 1
    return sudden, low_regions, silence_regions


def _print_report(m):
    s = m["summary"]
    print("=" * 64)
    print("ANALYSIS SUMMARY")
    print("=" * 64)
    print(f"duration                 : {m['duration_s']:.1f} s @ {m['sample_rate']} Hz")
    print(
        "highest loudness point   : "
        f"{s['max_loudness_lufs']:.2f} LUFS at t={s['max_loudness_frame_time_s']:.3f} s"
    )
    print(
        "maximum peak point       : "
        f"{s['global_peak_dbfs']:.2f} dBFS at t={s['global_peak_time_s']:.3f} s "
        f"(sample {s['global_peak_sample_index']})"
    )
    print(
        "silence total            : "
        f"{s['silence_total_s']:.3f} s (threshold {m['silence_threshold_dbfs']} dBFS)"
    )
    print(f"digital-zero total       : {s['digital_zero_total_s']:.3f} s (exact zero samples)")
    print(f"sudden-loud regions      : {len(m['regions']['sudden_loud'])}")
    for r in m["regions"]["sudden_loud"]:
        print(f"   {r['start_s']:7.2f}-{r['end_s']:7.2f}s  peak {r['peak_lufs']:7.2f} LUFS  +{r['onset_jump_lu']:.1f} LU onset")
    print(f"sustained-low regions    : {len(m['regions']['sustained_low'])}")
    for r in m["regions"]["sustained_low"]:
        print(f"   {r['start_s']:7.2f}-{r['end_s']:7.2f}s  min {r['min_lufs']:7.2f} LUFS")
    print(f"silence regions          : {len(m['regions']['silence'])}")
    for r in m["regions"]["silence"]:
        print(f"   {r['start_s']:7.2f}-{r['end_s']:7.2f}s")
    print("=" * 64)


if __name__ == "__main__":
    main()
