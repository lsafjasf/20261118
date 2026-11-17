"""Stereo width processing chain (pure stdlib).

Mid/Side based width control with correlation-aware limiting,
smoothed automation, and peak-safe auto gain.
"""

import math
import struct
import wave


def read_wav(path):
    """Return (channels, sample_rate, n_frames).

    channels is a list of per-channel float lists in [-1, 1].
    Supports 16/24/32-bit PCM.
    """
    with wave.open(path, "rb") as wf:
        n_ch = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        ints = struct.unpack("<%dh" % (len(raw) // 2), raw)
        scale = 32768.0
    elif width == 3:
        ints = []
        for i in range(len(raw) // 3):
            ints.append(int.from_bytes(raw[3 * i:3 * i + 3], "little",
                                       signed=True))
        scale = 8388608.0
    elif width == 4:
        ints = struct.unpack("<%di" % (len(raw) // 4), raw)
        scale = 2147483648.0
    else:
        raise ValueError("unsupported sample width: %d" % width)
    chans = [[] for _ in range(n_ch)]
    for i, v in enumerate(ints):
        chans[i % n_ch].append(v / scale)
    n = len(chans[0]) if chans else 0
    return chans, rate, n


def write_wav(path, chans, rate, width_bytes=2):
    """Write interleaved PCM WAV (16 or 24 bit). Clips to [-1, 1]."""
    n_ch = len(chans)
    n = len(chans[0])
    frames = bytearray()
    if width_bytes == 2:
        for i in range(n):
            for c in range(n_ch):
                v = max(-1.0, min(1.0, chans[c][i]))
                frames.extend(struct.pack("<h", int(round(v * 32767.0))))
    elif width_bytes == 3:
        for i in range(n):
            for c in range(n_ch):
                v = max(-1.0, min(1.0, chans[c][i]))
                frames.extend(int(round(v * 8388607.0)).to_bytes(
                    3, "little", signed=True))
    else:
        raise ValueError("width_bytes must be 2 or 3")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(n_ch)
        wf.setsampwidth(width_bytes)
        wf.setframerate(rate)
        wf.writeframes(bytes(frames))


def dbfs(x):
    return 20.0 * math.log10(max(x, 1e-9))


def peak(chans):
    p = 0.0
    for c in chans:
        for v in c:
            a = abs(v)
            if a > p:
                p = a
    return p


def correlation_blocks(left, right, rate, win_ms=50.0, hop_ms=10.0):
    """Windowed Pearson correlation between L and R.

    Returns (times, values): block center times (s) and corr in [-1, 1].
    Silent blocks report 1.0 (treated as mono-compatible / safe).
    """
    n = len(left)
    win = max(16, int(rate * win_ms / 1000.0))
    hop = max(1, int(rate * hop_ms / 1000.0))
    times, vals = [], []
    pos = 0
    while pos < n:
        end = min(n, pos + win)
        sl = left[pos:end]
        sr_ = right[pos:end]
        ml = sum(sl) / len(sl)
        mr = sum(sr_) / len(sr_)
        el = 0.0
        er = 0.0
        cross = 0.0
        for a, b in zip(sl, sr_):
            da = a - ml
            db = b - mr
            el += da * da
            er += db * db
            cross += da * db
        if el < 1e-12 or er < 1e-12:
            vals.append(1.0)
        else:
            vals.append(max(-1.0, min(1.0, cross / math.sqrt(el * er))))
        times.append((pos + end) * 0.5 / rate)
        pos += hop
    return times, vals


def mean_correlation(left, right, rate):
    _, vals = correlation_blocks(left, right, rate)
    return sum(vals) / len(vals) if vals else 1.0


class WidthProcessor:
    """Mid/Side stereo width processor.

    width > 1 widens, width < 1 narrows, 1.0 is unity.
    Widening is only allowed while the L/R correlation stays above
    corr_threshold; below it the effective width is pulled toward 1.0
    (never channel-swap, never fake-mono tricks). All parameter motion
    is smoothed, and a smooth limiter guarantees the output ceiling.
    """

    def __init__(self, rate, corr_threshold=0.0, width_attack_ms=15.0,
                 width_release_ms=150.0, ceiling_db=-1.0,
                 gain_attack_ms=5.0, gain_release_ms=150.0,
                 corr_win_ms=50.0, corr_hop_ms=10.0, meter_fps=30.0):
        self.rate = rate
        self.corr_threshold = corr_threshold
        self.width_attack_ms = width_attack_ms
        self.width_release_ms = width_release_ms
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.gain_attack_ms = gain_attack_ms
        self.gain_release_ms = gain_release_ms
        self.corr_win_ms = corr_win_ms
        self.corr_hop_ms = corr_hop_ms
        self.meter_fps = meter_fps

    def _allowed_width(self, user_width, corr):
        """Cap widening when correlation drops below the threshold."""
        if user_width <= 1.0:
            return user_width
        if corr >= self.corr_threshold:
            return user_width
        frac = (corr + 1.0) / (self.corr_threshold + 1.0)
        frac = max(0.0, min(1.0, frac))
        return 1.0 + (user_width - 1.0) * frac

    def process(self, left, right, width_fn):
        """width_fn: callable(t_seconds) -> user width (automation).

        Returns dict with output channels and meter history.
        """
        rate = self.rate
        n = len(left)
        dur = n / float(rate)

        # 1. correlation over time
        ct, cv = correlation_blocks(left, right, rate,
                                    self.corr_win_ms, self.corr_hop_ms)

        def corr_at(t):
            if t <= ct[0]:
                return cv[0]
            if t >= ct[-1]:
                return cv[-1]
            lo, hi = 0, len(ct) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if ct[mid] <= t:
                    lo = mid
                else:
                    hi = mid
            f = (t - ct[lo]) / (ct[hi] - ct[lo])
            return cv[lo] + (cv[hi] - cv[lo]) * f

        # 2. width stage with per-sample smoothed parameter.
        # Asymmetric smoothing: narrowing/ducking reacts fast (protects
        # anti-phase content), recovery is slow (no pumping).
        a_att = 1.0 - math.exp(-1.0 / (self.width_attack_ms * 0.001 * rate))
        a_rel = 1.0 - math.exp(-1.0 / (self.width_release_ms * 0.001
                                       * rate))
        out_l = [0.0] * n
        out_r = [0.0] * n
        w = self._allowed_width(width_fn(0.0), corr_at(0.0))
        meter_step = max(1, int(rate / self.meter_fps))
        times, user_w, appl_w, corrs = [], [], [], []
        for i in range(n):
            t = i / rate
            target = self._allowed_width(width_fn(t), corr_at(t))
            w += (target - w) * (a_att if target < w else a_rel)
            m = 0.5 * (left[i] + right[i])
            s = 0.5 * (left[i] - right[i]) * w
            out_l[i] = m + s
            out_r[i] = m - s
            if i % meter_step == 0:
                times.append(t)
                user_w.append(width_fn(t))
                appl_w.append(w)
                corrs.append(corr_at(t))

        # 3. peak-safe auto gain (smooth limiter, guaranteed ceiling)
        out_l, out_r, gain_db = self._auto_gain(out_l, out_r, times)

        return {
            "left": out_l, "right": out_r, "duration": dur,
            "times": times, "user_width": user_w,
            "applied_width": appl_w, "correlation": corrs,
            "gain_db": gain_db,
        }
    def _auto_gain(self, left, right, times):
        """Smooth limiter: gain <= ceiling/peak everywhere, so the
        output can never exceed the ceiling. Attack ramps down ahead
        of peaks (backward pass), release ramps up slowly (forward
        pass) to avoid pumping."""
        n = len(left)
        rate = self.rate
        need = [0.0] * n
        for i in range(n):
            p = abs(left[i])
            q = abs(right[i])
            if q > p:
                p = q
            need[i] = min(1.0, self.ceiling / max(p, 1e-9))
        ka = math.exp(1.0 / (self.gain_attack_ms * 0.001 * rate))
        kr = math.exp(1.0 / (self.gain_release_ms * 0.001 * rate))
        # backward pass: pre-duck before peaks
        g = need[:]
        prev = g[-1]
        for i in range(n - 2, -1, -1):
            lim = prev * ka
            if g[i] > lim:
                g[i] = lim
            prev = g[i]
        # forward pass: slow release
        prev = g[0]
        for i in range(1, n):
            lim = prev * kr
            if g[i] > lim:
                g[i] = lim
            prev = g[i]
        for i in range(n):
            left[i] *= g[i]
            right[i] *= g[i]
        # gain meter at the same time base as the other meters
        step = max(1, int(rate / self.meter_fps))
        gain_db = []
        for j, _ in enumerate(times):
            i = min(n - 1, j * step)
            gain_db.append(dbfs(g[i]))
        return left, right, gain_db
