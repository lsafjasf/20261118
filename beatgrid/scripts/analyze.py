"""Analyze a track: detect attacks, classify tempo behavior, build grid.

Output JSON contains:
  onsets, grid (mode-specific), confidence, mean_grid_error, bpm_curve.
The grid is intentionally NOT forced to fixed tempo for ramp/free material.
"""

import argparse
import json
import os

import numpy as np

from audioio import read_wav, downmix_peaks
from onsets import (
    detect_onsets,
    dominant_period,
    fit_constant,
    fit_ramp,
    ramp_bpm_curve,
    grid_errors,
    smooth_periods,
    tempo_clarity,
)


def build_constant_grid(phi, period, duration):
    k0 = int(np.floor(-phi / period)) - 1
    k1 = int(np.ceil((duration - phi) / period)) + 1
    k = np.arange(k0, k1 + 1)
    times = phi + k * period
    keep = (times > 0) & (times < duration)
    return [
        {"index": int(kk), "time": float(tt), "bar": int(kk // 4), "beat_in_bar": int(kk % 4)}
        for kk, tt in zip(k[keep], times[keep])
    ]


def build_ramp_grid(onsets, k, params, duration):
    t0 = onsets[0]
    periods = np.array(params[2])
    k_lo, k_hi = int(k.min()) - 2, int(k.max()) + 2
    out = []
    times = {}
    times[int(k.min())] = t0
    for kk in range(int(k.min()) + 1, int(k.max()) + 1):
        p = periods[min(kk - int(k.min()), len(periods) - 1)]
        times[kk] = times[kk - 1] + p
    for kk in range(k_lo, k_hi + 1):
        if kk in times:
            t = times[kk]
        elif kk < int(k.min()):
            t = times[int(k.min())] - periods[0] * (int(k.min()) - kk)
        else:
            t = times[int(k.max())] + periods[-1] * (kk - int(k.max()))
        if 0 < t < duration:
            out.append({
                "index": int(kk),
                "time": float(t),
                "bar": int(kk // 4),
                "beat_in_bar": int(kk % 4),
            })
    return out


def analyze(wav_path):
    x, sr = read_wav(wav_path)
    duration = len(x) / sr
    onsets, strengths, flux, frame_dt, beat_onsets = detect_onsets(x, sr)
    if len(onsets) < 4:
        raise RuntimeError(f"too few onsets ({len(onsets)}) in {wav_path}")
    if len(beat_onsets) < 4:
        beat_onsets = onsets

    period, hist_clarity, _, _ = dominant_period(beat_onsets)
    const_grid, const_k, phi = fit_constant(beat_onsets, period)
    const_err = grid_errors(beat_onsets, const_grid)

    ramp = fit_ramp(beat_onsets)
    if ramp is not None:
        ramp_grid_on, ramp_k, ramp_params = ramp
        ramp_err = grid_errors(beat_onsets, ramp_grid_on)
    else:
        ramp_grid_on, ramp_k, ramp_params = const_grid, const_k, (period, 0.0)
        ramp_err = const_err

    clarity = tempo_clarity(beat_onsets)
    _, predict_resid = smooth_periods(beat_onsets)
    const_mae = float(np.mean(const_err))
    ramp_mae = float(np.mean(ramp_err))
    improvement = (const_mae - ramp_mae) / max(const_mae, 1e-9)

    if clarity >= 0.85 and const_mae <= 0.02:
        mode = "constant"
    elif predict_resid <= 0.02 and improvement >= 0.3:
        mode = "ramp"
    else:
        mode = "free"

    if mode == "constant":
        bpm = 60.0 / period
        bpm_curve = [[0.0, bpm], [duration, bpm]]
        grid = build_constant_grid(phi, period, duration)
        mae, med = const_mae, float(np.median(const_err))
        confidence = float(np.clip(
            0.55 * clarity + 0.45 * (1 - min(const_mae / 0.05, 1.0)), 0, 1
        ))
    elif mode == "ramp":
        bpm_curve = ramp_bpm_curve(beat_onsets, ramp_k, ramp_params)
        grid = build_ramp_grid(beat_onsets, ramp_k, ramp_params, duration)
        mae, med = ramp_mae, float(np.median(ramp_err))
        confidence = float(np.clip(
            0.5 * clarity + 0.5 * (1 - min(ramp_mae / 0.05, 1.0)), 0, 1
        ))
    else:
        iv = np.diff(beat_onsets)
        local_bpm = np.concatenate([[60.0 / iv[0]], 60.0 / iv])
        bpm_curve = [[float(t), float(b)] for t, b in zip(beat_onsets, local_bpm)]
        grid = [
            {
                "index": i,
                "time": float(t),
                "bar": i // 4,
                "beat_in_bar": i % 4,
                "free": True,
            }
            for i, t in enumerate(beat_onsets)
        ]
        mae = 0.0
        med = 0.0
        confidence = float(np.clip(clarity * 0.6, 0, 1))

    low, low_sr, blocks = downmix_peaks(x, sr)
    step = sr // low_sr
    peaks = blocks.max(axis=1)
    rms = np.sqrt((blocks**2).mean(axis=1) + 1e-12)
    waveform = {
        "sample_rate": sr,
        "view_rate": low_sr,
        "block": step,
        "peak": peaks.tolist(),
        "rms": rms.tolist(),
        "duration": duration,
    }

    return {
        "audio": os.path.basename(wav_path),
        "duration": duration,
        "mode": mode,
        "confidence": round(confidence, 4),
        "mean_grid_error_ms": round(mae * 1000, 2),
        "median_grid_error_ms": round(med * 1000, 2),
        "diagnostics": {
            "tempo_clarity": round(clarity, 4),
            "histogram_clarity": round(hist_clarity, 4),
            "period_predict_residual": round(predict_resid, 5),
            "onset_count": int(len(onsets)),
            "beat_onset_count": int(len(beat_onsets)),
            "constant_mae_ms": round(const_mae * 1000, 2),
            "ramp_mae_ms": round(ramp_mae * 1000, 2),
            "ramp_improvement": round(improvement, 4),
            "dominant_period_s": None if period is None else round(period, 4),
        },
        "onsets": [
            {"time": float(t), "strength": float(s)}
            for t, s in zip(onsets, strengths)
        ],
        "grid": grid,
        "bpm_curve": [[round(t, 4), round(b, 2)] for t, b in bpm_curve],
        "waveform": waveform,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", nargs="+")
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for wav in args.wav:
        result = analyze(wav)
        name = os.path.splitext(os.path.basename(wav))[0]
        out = os.path.join(out_dir, f"{name}.analysis.json")
        with open(out, "w") as f:
            json.dump(result, f)
        d = result["diagnostics"]
        print(
            f"{name}: mode={result['mode']:8s} conf={result['confidence']:.3f} "
            f"mae={result['mean_grid_error_ms']:6.2f}ms "
            f"clarity={d['tempo_clarity']:.3f} const={d['constant_mae_ms']}ms "
            f"ramp={d['ramp_mae_ms']}ms"
        )


if __name__ == "__main__":
    main()
