"""WSOLA kernel: phase continuity, monotonic cursor, pitch preservation."""

import numpy as np

from player.wsola import WsolaStretcher

SR = 44100


def tone(freqs=(220, 440), seconds=4.0):
    t = np.arange(int(SR * seconds)) / SR
    return sum(0.4 * np.sin(2 * np.pi * f * t) for f in freqs)


def render(src, segments):
    """segments: list of (speed, input_samples) consumed in order."""
    s = WsolaStretcher(SR)
    s.feed(src, final=True)
    out = []
    for speed, n_in in segments:
        s.set_speed(speed)
        out.append(s.pull(int(n_in / speed)))
    return s, np.concatenate(out)[:, 0]


def test_unity_speed_is_near_identity():
    src = tone()
    s = WsolaStretcher(SR)
    s.feed(src, final=True)
    out = s.pull(len(src))[:, 0]
    interior = slice(4096, -4096)
    assert np.abs(out[interior] - src[interior]).max() < 0.05


def test_cursor_never_moves_backwards_no_repeated_words():
    src = tone(seconds=6.0)
    segs = [(1.0, SR), (2.0, SR), (0.5, SR), (1.5, SR), (0.75, SR), (1.0, SR)]
    s, _ = render(src, segs)
    ks = np.array([k for _, k in s.trace])
    assert (np.diff(ks) >= 0).all()


def test_no_forward_skips_beyond_search_window():
    src = tone(seconds=6.0)
    segs = [(2.0, 2 * SR), (0.5, SR), (1.5, SR)]
    s, _ = render(src, segs)
    ks = np.array([k for _, k in s.trace])
    max_jump = s.hop * 2.0 + 2 * s.search  # analysis hop + search slack
    assert np.diff(ks).max() <= max_jump


def test_output_has_no_zero_holes_midstream():
    src = tone(seconds=4.0)
    _, out = render(src, [(2.0, 2 * SR), (0.5, SR), (1.0, SR)])
    body = out[4096:-4096]
    max_run = _max_zero_run(body)
    assert max_run < 64, f"zero hole of {max_run} samples mid-stream"


def _max_zero_run(x, thresh=1e-9):
    z = (np.abs(x) < thresh).astype(np.int8)
    d = np.diff(np.concatenate(([0], z, [0])))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return int((ends - starts).max()) if starts.size else 0


def test_pitch_preserved_at_extreme_speeds():
    src = tone(freqs=(220,), seconds=6.0)
    for speed in (0.5, 2.0):
        s = WsolaStretcher(SR)
        s.set_speed(speed)
        s.feed(src, final=True)
        out = s.pull(int(2 * SR))[:, 0]
        seg = out[out.size // 4 : out.size // 2]
        freqs = np.fft.rfftfreq(len(seg), 1 / SR)
        peak = freqs[np.argmax(np.abs(np.fft.rfft(seg)))]
        assert abs(peak - 220) < 5
