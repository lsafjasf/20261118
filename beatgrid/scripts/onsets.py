"""Onset detection and tempo grid fitting (constant / ramp / free)."""

import numpy as np
from scipy.signal import find_peaks


def stft_mag(x, sr, n_fft=1024, hop=256):
    window = np.hanning(n_fft)
    n_frames = 1 + (len(x) - n_fft) // hop
    frames = np.lib.stride_tricks.as_strided(
        x,
        shape=(n_frames, n_fft),
        strides=(x.strides[0] * hop, x.strides[0]),
    )
    spec = np.fft.rfft(frames * window, axis=1)
    return np.abs(spec), hop / sr


def spectral_flux(mag):
    diff = np.diff(mag, axis=0, prepend=mag[:1])
    return np.maximum(diff, 0).sum(axis=1)


def low_flux(mag, sr, n_fft, cutoff_hz=250.0):
    """Spectral flux restricted to low-frequency bins (drum-weighted)."""
    bin_hz = sr / n_fft
    k = max(2, int(cutoff_hz / bin_hz))
    diff = np.diff(mag[:, :k], axis=0, prepend=mag[:1, :k])
    return np.maximum(diff, 0).sum(axis=1)


def pick_peaks(flux, frame_dt, min_gap_s=0.06, rel_thresh=1.4, sigma_frames=12):
    flux = np.convolve(flux, np.ones(3) / 3, mode="same")
    kernel = np.ones(sigma_frames) / sigma_frames
    local = np.convolve(flux, kernel, mode="same")
    height = local * rel_thresh + flux.std() * 0.35
    min_dist = int(min_gap_s / frame_dt)
    peaks, _ = find_peaks(flux, height=height, distance=min_dist)
    return peaks


def refine_peaks(peaks, flux):
    """Parabolic interpolation for sub-frame peak positions."""
    out = np.empty(len(peaks), dtype=float)
    for i, p in enumerate(peaks):
        if 0 < p < len(flux) - 1:
            y0, y1, y2 = flux[p - 1], flux[p], flux[p + 1]
            denom = y0 - 2 * y1 + y2
            delta = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
            out[i] = p + np.clip(delta, -1.0, 1.0)
        else:
            out[i] = p
    return out


def refine_to_envelope(peak_times, x, sr, win_s=0.06):
    """Snap each flux peak to the earliest sample of a rising energy edge."""
    win = int(win_s * sr)
    energy = x**2
    out = []
    for t in peak_times:
        center = int(t * sr)
        lo = max(1, center - win)
        hi = min(len(energy) - 1, center + win // 2)
        if hi <= lo:
            out.append(t)
            continue
        seg = energy[lo:hi]
        base = np.median(seg[: max(4, len(seg) // 6)])
        thr = base + 0.25 * (seg.max() - base)
        idx = np.argmax(seg > thr)
        out.append((lo + idx) / sr)
    return np.array(out)


def detect_onsets(x, sr):
    n_fft = 1024
    mag, frame_dt = stft_mag(x, sr, n_fft=n_fft)
    flux = spectral_flux(mag)
    peaks = pick_peaks(flux, frame_dt, min_gap_s=0.05, rel_thresh=1.3)
    strengths = flux[peaks]
    if len(strengths):
        strengths = strengths / strengths.max()
    low = low_flux(mag, sr, n_fft)
    beat_peaks = pick_peaks(
        low, frame_dt, min_gap_s=0.18, rel_thresh=1.25
    )
    beat_times = refine_to_envelope(
        refine_peaks(beat_peaks, low) * frame_dt, x, sr
    )
    peak_times = refine_to_envelope(refine_peaks(peaks, flux) * frame_dt, x, sr)
    return peak_times, strengths, flux, frame_dt, beat_times


def interval_histogram(onsets, lo_bpm=55.0, hi_bpm=200.0, bins=240):
    iv = np.diff(onsets)
    iv = iv[(iv > 60 / hi_bpm) & (iv < 60 / lo_bpm)]
    if len(iv) < 2:
        return np.linspace(60 / hi_bpm, 60 / lo_bpm, bins), np.zeros(bins - 1)
    edges = np.linspace(60 / hi_bpm, 60 / lo_bpm, bins)
    hist, _ = np.histogram(iv, bins=edges)
    hist = np.convolve(hist, np.ones(5) / 5, mode="same")
    return edges, hist


def dominant_period(onsets):
    """Autocorrelation of the onset impulse train; robust to slow drift."""
    edges, hist = interval_histogram(onsets)
    if len(onsets) < 4:
        return None, 0.0, hist, edges
    dt = 0.005
    t_max = onsets[-1] - onsets[0]
    lag_max = int((60.0 / 55.0) / dt)
    lag_min = int((60.0 / 200.0) / dt)
    grid_t = np.arange(0, t_max, dt)
    train = np.zeros_like(grid_t)
    idx = np.round((onsets - onsets[0]) / dt).astype(int)
    train[idx[idx < len(train)]] = 1.0
    ac = np.correlate(train, train, mode="full")[len(train) - 1:]
    search = ac[lag_min:lag_max]
    if search.sum() == 0:
        return None, 0.0, hist, edges
    k = int(np.argmax(search)) + lag_min
    period = k * dt
    expected = np.sum(train)
    clarity = float(np.clip(ac[k] / max(expected, 1), 0, 1))
    return period, clarity, hist, edges


def fit_constant(onsets, period, t0_hint=None):
    """Grid t = phi + k*period; choose phi minimizing median abs error."""
    phi = onsets[0]
    best_score = np.inf
    for phi0 in np.linspace(0, period, 401, endpoint=False):
        nearest = phi0 + np.round((onsets - phi0) / period) * period
        errs = np.abs(onsets - nearest)
        score = np.median(errs) + 0.1 * errs.mean()
        if score < best_score:
            best_score = score
            phi = phi0
    k = np.round((onsets - phi) / period).astype(int)
    grid = phi + k * period
    return grid, k, phi


def fit_ramp(onsets):
    """Fit a smoothly varying tempo via smoothed per-beat periods.

    Periods are estimated from consecutive onset gaps, denoised with a
    triangular smoothing window, and integrated into a beat-time map.
    This handles linear and exponential tempo change without forcing a
    single analytic curve.
    """
    n = len(onsets)
    if n < 4:
        return None
    k_idx = np.arange(n)
    smooth, _ = smooth_periods(onsets)
    gaps = np.diff(onsets)
    periods = np.concatenate([[smooth[0]], smooth])
    anchor = onsets[0]
    grid = np.concatenate([[anchor], anchor + np.cumsum(periods[1:])])
    slope = np.polyfit(k_idx, periods, 1)[0]
    return grid, k_idx, (float(periods[0]), float(slope), periods.tolist())


def ramp_bpm_curve(onsets, k, params):
    periods = np.array(params[2])
    bpms = 60.0 / np.maximum(periods, 1e-3)
    return list(zip(onsets.tolist(), bpms.tolist()))


def grid_errors(onsets, grid):
    return np.abs(onsets - grid)


def tempo_clarity(onsets):
    """Stability of adjacent inter-onset intervals, normalized 0..1."""
    iv = np.diff(onsets)
    if len(iv) < 3:
        return 0.0
    cv = np.std(iv) / max(np.mean(iv), 1e-9)
    return float(np.clip(1.0 - cv / 0.35, 0.0, 1.0))


def smooth_periods(onsets):
    """Triangular-window smoothed local periods plus residual ratio."""
    n = len(onsets)
    gaps = np.diff(onsets)
    win = max(3, n // 5)
    if win % 2 == 0:
        win += 1
    kernel = np.bartlett(win)
    kernel /= kernel.sum()
    padded = np.pad(gaps, (win // 2, win // 2), mode="edge")
    smooth = np.convolve(padded, kernel, mode="valid")
    if len(smooth) != len(gaps):
        smooth = np.interp(np.arange(len(gaps)), np.arange(len(smooth)), smooth)
    resid_ratio = float(np.mean(np.abs(gaps - smooth)) / max(np.mean(gaps), 1e-9))
    return smooth, resid_ratio
