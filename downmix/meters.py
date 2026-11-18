"""Level metering, RMS / clipping statistics and fold-down diagnostics.

All functions operate on plain float lists so they run without numpy.
"""

from __future__ import annotations

import math

from .engine import CHANNELS

# A sample at or beyond full scale counts as a clipped sample.
CLIP_THRESHOLD = 1.0

# Diagnostic warning thresholds (tuned for programme-level signals).
CENTER_DOMINANCE_WARN = 0.75
SURROUND_RETENTION_WARN = 0.5


class ChannelStats:
    def __init__(self, name, rms, peak, clip_count, sample_count):
        self.name = name
        self.rms = rms
        self.peak = peak
        self.clip_count = clip_count
        self.sample_count = sample_count

    @property
    def rms_db(self):
        if self.rms <= 0.0:
            return float("-inf")
        return 20.0 * math.log10(self.rms)

    @property
    def peak_db(self):
        if self.peak <= 0.0:
            return float("-inf")
        return 20.0 * math.log10(self.peak)

    @property
    def crest_factor_db(self):
        if self.rms <= 0.0 or self.peak <= 0.0:
            return float("-inf")
        return 20.0 * math.log10(self.peak / self.rms)

    def as_dict(self):
        return {
            "channel": self.name,
            "rms": self.rms,
            "rms_dbfs": self.rms_db,
            "peak": self.peak,
            "peak_dbfs": self.peak_db,
            "crest_factor_db": self.crest_factor_db,
            "clipped_samples": self.clip_count,
            "sample_count": self.sample_count,
        }


def deinterleave(samples, n_channels: int):
    """Split a frame-major flat buffer into per-channel lists."""
    channels = [[] for _ in range(n_channels)]
    for index, value in enumerate(samples):
        channels[index % n_channels].append(value)
    return channels


def stats_for_channel(name: str, values) -> ChannelStats:
    count = len(values)
    peak = 0.0
    square_sum = 0.0
    clips = 0
    for value in values:
        magnitude = abs(value)
        if magnitude > peak:
            peak = magnitude
        if magnitude >= CLIP_THRESHOLD:
            clips += 1
        square_sum += value * value
    rms = math.sqrt(square_sum / count) if count else 0.0
    return ChannelStats(name, rms, peak, clips, count)


def channel_stats(samples, n_channels: int, names=None):
    """RMS / peak / clipping statistics for every input channel."""
    labels = list(names or CHANNELS)
    if len(labels) != n_channels:
        raise ValueError("names length must match channel count")
    planar = deinterleave(samples, n_channels)
    return [stats_for_channel(labels[i], planar[i]) for i in range(n_channels)]


def _rms(values) -> float:
    if not values:
        return 0.0
    return math.sqrt(sum(v * v for v in values) / len(values))


def pearson_correlation(left, right) -> float:
    """Pearson r between L and R; 1.0 = identical, -1.0 = fully out of phase."""
    n = min(len(left), len(right))
    if n == 0:
        return 0.0
    mean_l = sum(left[:n]) / n
    mean_r = sum(right[:n]) / n
    cov = 0.0
    var_l = 0.0
    var_r = 0.0
    for i in range(n):
        dl = left[i] - mean_l
        dr = right[i] - mean_r
        cov += dl * dr
        var_l += dl * dl
        var_r += dr * dr
    denom = math.sqrt(var_l * var_r)
    if denom == 0.0:
        return 0.0
    return cov / denom


def stereo_planar(stereo):
    return stereo[0::2], stereo[1::2]


def center_dominance(left, right) -> float:
    """Fraction of stereo energy carried by the mono (mid) component.

    A value near 1.0 means everything is centred and the mix is mono;
    useful for spotting an over-strong centre channel.
    """
    n = min(len(left), len(right))
    if n == 0:
        return 0.0
    mid_energy = 0.0
    total_energy = 0.0
    for i in range(n):
        mid = 0.5 * (left[i] + right[i])
        side = 0.5 * (left[i] - right[i])
        mid_energy += mid * mid
        total_energy += mid * mid + side * side
    if total_energy == 0.0:
        return 0.0
    return mid_energy / total_energy


def surround_retention(samples, stereo, config) -> float:
    """Surround energy surviving in the mono (L+R, mid) fold-down.

    Ls feeds L and Rs feeds R. Mono compatibility sums L+R, so the
    surround term becomes (ls + rs). Opposite-polarity Ls/Rs material
    cancels there and the surrounds disappear on mono playback;
    independent surrounds retain their energy. Returns 0..1, where near
    zero means the surround pair effectively vanishes after summing.
    """
    nframes = len(samples) // 6
    coeff = config.effective_gain("Ls"), config.effective_gain("Rs")
    source_energy = 0.0
    mono_energy = 0.0
    for frame in range(nframes):
        base = frame * 6
        ls = samples[base + 4] * coeff[0]
        rs = samples[base + 5] * coeff[1]
        source_energy += ls * ls + rs * rs
        mono_energy += (ls + rs) * (ls + rs)
    if source_energy == 0.0:
        return 1.0
    # Independent Ls/Rs: E[(ls+rs)^2] ~= E[ls^2]+E[rs^2] -> ratio ~1.
    # Exact opposites (rs = -ls) collapse the mono sum to zero.
    return max(0.0, min(1.0, mono_energy / source_energy))


def surround_cancellation(samples, config) -> float:
    """Destructive-interference score for the surround pair, in [0, 1].

    0 means independent/healthy surrounds; 1 means Ls and Rs are exact
    opposites after gain, so their shared component cancels in the
    side (L-R) signal.
    """
    nframes = len(samples) // 6
    gls = config.effective_gain("Ls")
    grs = config.effective_gain("Rs")
    dot = 0.0
    norm_ls = 0.0
    norm_rs = 0.0
    for frame in range(nframes):
        base = frame * 6
        ls = samples[base + 4] * gls
        rs = samples[base + 5] * grs
        dot += ls * rs
        norm_ls += ls * ls
        norm_rs += rs * rs
    denom = math.sqrt(norm_ls * norm_rs)
    if denom == 0.0:
        return 0.0
    correlation = dot / denom  # -1 (opposites) .. 1 (identical)
    return max(0.0, -correlation)


def analyze(samples, n_channels: int, stereo, config):
    """Full diagnostic bundle returned by the CLI / UI."""
    input_stats = channel_stats(samples, n_channels)
    left, right = stereo_planar(stereo)
    output_stats = channel_stats(stereo, 2, names=("L_out", "R_out"))
    dominance = center_dominance(left, right)
    correlation = pearson_correlation(left, right)
    cancellation = surround_cancellation(samples, config)
    retention = surround_retention(samples, stereo, config)
    warnings = []
    if dominance >= CENTER_DOMINANCE_WARN:
        warnings.append(
            "centre dominance %.0f%% (>= %.0f%%): centre channel too strong"
            % (dominance * 100.0, CENTER_DOMINANCE_WARN * 100.0)
        )
    if retention < SURROUND_RETENTION_WARN:
        warnings.append(
            "surround mono-retention %.0f%% (< %.0f%%): surrounds cancel when "
            "L/R are summed (cancellation score %.2f)"
            % (retention * 100.0, SURROUND_RETENTION_WARN * 100.0,
               cancellation)
        )
    if correlation <= -0.9:
        warnings.append(
            "stereo L/R correlation %.2f: near full out-of-phase signal"
            % correlation
        )
    for stat in input_stats:
        if stat.clip_count:
            warnings.append(
                "input channel %s has %d clipped sample(s)"
                % (stat.name, stat.clip_count)
            )
    return {
        "input_stats": input_stats,
        "output_stats": output_stats,
        "stereo_correlation": correlation,
        "center_dominance": dominance,
        "surround_cancellation": cancellation,
        "surround_retention": retention,
        "warnings": warnings,
    }
