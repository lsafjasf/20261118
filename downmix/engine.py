"""Configurable 5.1 -> stereo downmix engine.

Standard reference layout (ITU-R BS.775 / ATSC style):

    L_out = L + 10**(-3/20) * (C + Ls)        (plus LFE when enabled)
    R_out = R + 10**(-3/20) * (C + Rs)

Every coefficient is user adjustable. Dialogue protection is an extra
gain applied only to the centre channel, independent of the centre's
regular downmix gain.
"""

from __future__ import annotations

import math

CHANNELS = ("L", "R", "C", "LFE", "Ls", "Rs")

# Linear gain sentinel meaning "channel muted" (e.g. LFE by default).
MUTED = 0.0

DEFAULT_GAIN_DB = {
    "L": 0.0,
    "R": 0.0,
    "C": -3.0,
    "LFE": float("-inf"),  # LFE is excluded from the fold-down by default
    "Ls": -3.0,
    "Rs": -3.0,
}


def db_to_linear(db: float) -> float:
    if db == float("-inf") or db <= -200.0:
        return 0.0
    return 10.0 ** (db / 20.0)


def linear_to_db(linear: float) -> float:
    if linear <= 0.0:
        return float("-inf")
    return 20.0 * math.log10(linear)


class DownmixConfig:
    """All downmix parameters.

    gain_db: per-channel downmix gain in dB.
    dialogue_protection_db: extra boost applied to C only.
    solo: channels that are auditioned alone (empty = normal mix).
    muted: channels temporarily silenced.
    soft_clip: saturate instead of hard clipping when output exceeds 1.0.
    """

    def __init__(self, gain_db=None, dialogue_protection_db: float = 0.0,
                 solo=None, muted=None, soft_clip: bool = True):
        self.gain_db = dict(DEFAULT_GAIN_DB)
        if gain_db:
            for name, value in gain_db.items():
                if name not in CHANNELS:
                    raise ValueError("unknown channel %r" % name)
                self.gain_db[name] = float(value)
        self.dialogue_protection_db = float(dialogue_protection_db)
        self.solo = set(solo or ())
        self.muted = set(muted or ())
        for name in self.solo | self.muted:
            if name not in CHANNELS:
                raise ValueError("unknown channel %r" % name)
        self.soft_clip = soft_clip

    def effective_gain(self, name: str) -> float:
        """Linear gain actually applied to a channel given solo/mute state."""
        if name in self.muted:
            return MUTED
        if self.solo and name not in self.solo:
            return MUTED
        gain = db_to_linear(self.gain_db[name])
        if name == "C":
            gain *= db_to_linear(self.dialogue_protection_db)
        return gain

    def coefficients(self):
        """Return (left_coeffs, right_coeffs) linear coefficient per channel."""
        gains = {name: self.effective_gain(name) for name in CHANNELS}
        left = {
            "L": gains["L"],
            "R": 0.0,
            "C": gains["C"],
            "LFE": gains["LFE"],
            "Ls": gains["Ls"],
            "Rs": 0.0,
        }
        right = {
            "L": 0.0,
            "R": gains["R"],
            "C": gains["C"],
            "LFE": gains["LFE"],
            "Ls": 0.0,
            "Rs": gains["Rs"],
        }
        return left, right

    def clone(self):
        return DownmixConfig(
            gain_db=dict(self.gain_db),
            dialogue_protection_db=self.dialogue_protection_db,
            solo=set(self.solo),
            muted=set(self.muted),
            soft_clip=self.soft_clip,
        )


def _tanh_soft_clip(value: float) -> float:
    if value > 3.0:
        return 1.0
    if value < -3.0:
        return -1.0
    return math.tanh(value)


def downmix(samples, n_channels: int, config: DownmixConfig):
    """Fold an interleaved multi-channel buffer down to interleaved stereo.

    ``samples`` is frame-major flat floats with ``n_channels`` per frame.
    Returns a flat list ``[L0, R0, L1, R1, ...]`` plus a dict of per-output
    peak values measured before saturation.
    """
    if n_channels != 6:
        raise ValueError(
            "expected 6 channels (L,R,C,LFE,Ls,Rs), got %d" % n_channels
        )
    left_coeff, right_coeff = config.coefficients()
    nframes = len(samples) // 6
    stereo = [0.0] * (nframes * 2)
    pre_clip_peak = {"L": 0.0, "R": 0.0}
    for frame in range(nframes):
        base = frame * 6
        left_sum = 0.0
        right_sum = 0.0
        for index, name in enumerate(CHANNELS):
            value = samples[base + index]
            left_sum += value * left_coeff[name]
            right_sum += value * right_coeff[name]
        peak_l = abs(left_sum)
        peak_r = abs(right_sum)
        if peak_l > pre_clip_peak["L"]:
            pre_clip_peak["L"] = peak_l
        if peak_r > pre_clip_peak["R"]:
            pre_clip_peak["R"] = peak_r
        if config.soft_clip:
            left_sum = _tanh_soft_clip(left_sum)
            right_sum = _tanh_soft_clip(right_sum)
        out = frame * 2
        stereo[out] = left_sum
        stereo[out + 1] = right_sum
    return stereo, pre_clip_peak
