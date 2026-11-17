"""Generate test WAVs for the stereo width chain (pure stdlib).

Creates in artifacts/:
  in_mono.wav       - true mono source (1 channel)
  in_antiphase.wav  - stereo with an out-of-phase middle segment
  in_wide_music.wav - wide stereo synthesized music
"""

import math
import os

from stereo_width import write_wav

RATE = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts")


def sine(freq, i, rate=RATE, phase=0.0):
    return math.sin(2.0 * math.pi * freq * i / rate + phase)


def adsr(t, a, d, s, r, dur):
    if t < 0.0 or t > dur + r:
        return 0.0
    if t < a:
        return t / a
    if t < a + d:
        return 1.0 - (1.0 - s) * (t - a) / d
    if t < dur:
        return s
    return s * (1.0 - (t - dur) / r)


def note(freq, t0, dur, amp=0.3, kind="tri"):
    """Return f(i) sample function for one note."""
    def f(i):
        t = i / RATE - t0
        e = adsr(t, 0.01, 0.08, 0.7, 0.1, dur)
        if e <= 0.0:
            return 0.0
        ph = 2.0 * math.pi * freq * t
        if kind == "tri":
            v = 2.0 / math.pi * math.asin(math.sin(ph))
        elif kind == "saw":
            v = 0.0
            for h in range(1, 8):
                v += math.sin(ph * h) / h
            v *= 0.5
        else:
            v = math.sin(ph)
        return amp * e * v
    return f


def render(n, voices):
    """Sum voice sample-functions into a mono float list."""
    out = [0.0] * n
    for f in voices:
        for i in range(n):
            out[i] += f(i)
    return out
def make_mono(path, dur=6.0):
    n = int(dur * RATE)
    scale = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3]
    voices = []
    t = 0.1
    k = 0
    while t < dur - 0.5:
        voices.append(note(scale[k % len(scale)], t, 0.35, 0.4, "tri"))
        voices.append(note(scale[k % len(scale)] / 2.0, t, 0.35, 0.25,
                           "sine"))
        t += 0.4
        k += 1
    mono = render(n, voices)
    write_wav(path, [mono], RATE)
    return path


def make_antiphase(path, dur=8.0):
    """Stereo: wide-ish content, but 3s..5s is fully out of phase."""
    n = int(dur * RATE)
    voices_l = [note(220.0, 0.1, dur - 0.2, 0.3, "saw"),
                note(331.1, 0.1, dur - 0.2, 0.2, "saw")]
    voices_r = [note(220.0, 0.1, dur - 0.2, 0.3, "saw"),
                note(329.6, 0.1, dur - 0.2, 0.2, "saw")]
    left = render(n, voices_l)
    right = render(n, voices_r)
    lo, hi = int(3.0 * RATE), int(5.0 * RATE)
    for i in range(lo, hi):
        mid = 0.5 * (left[i] + right[i])
        left[i] = mid
        right[i] = -mid
    write_wav(path, [left, right], RATE)
    return path


def make_wide_music(path, dur=10.0, bpm=112.0):
    """Wide stereo mix: centered kick+bass, detuned wide pad, melody."""
    n = int(dur * RATE)
    beat = 60.0 / bpm
    chords = [(261.6, 329.6, 392.0), (220.0, 261.6, 329.6),
              (174.6, 220.0, 261.6), (196.0, 246.9, 293.7)]
    left_v, right_v = [], []
    # pad: each chord tone doubled with detune, hard-ish panned
    t = 0.0
    ci = 0
    while t < dur - 1.0:
        for f in chords[ci % len(chords)]:
            left_v.append(note(f * 1.003, t, beat * 4, 0.16, "saw"))
            right_v.append(note(f * 0.997, t, beat * 4, 0.16, "saw"))
        t += beat * 4
        ci += 1
    # melody: alternating pan
    scale = [523.3, 587.3, 659.3, 784.0, 880.0]
    t = 0.5
    k = 0
    while t < dur - 0.5:
        f = scale[k % len(scale)]
        pan = 0.6 if k % 2 == 0 else -0.6
        g_l = math.cos((pan + 1.0) * math.pi / 4.0)
        g_r = math.sin((pan + 1.0) * math.pi / 4.0)
        left_v.append(note(f, t, 0.3, 0.35 * g_l, "tri"))
        right_v.append(note(f, t, 0.3, 0.35 * g_r, "tri"))
        t += beat
        k += 1
    left = render(n, left_v)
    right = render(n, right_v)
    # centered kick + bass added equally to both sides
    center_v = []
    t = 0.0
    while t < dur - 0.2:
        center_v.append(note(55.0, t, 0.25, 0.5, "sine"))
        center_v.append(note(110.0, t, beat * 0.9, 0.2, "saw"))
        t += beat
    center = render(n, center_v)
    for i in range(n):
        left[i] += center[i]
        right[i] += center[i]
    write_wav(path, [left, right], RATE)
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    for p in (make_mono(os.path.join(OUT, "in_mono.wav")),
              make_antiphase(os.path.join(OUT, "in_antiphase.wav")),
              make_wide_music(os.path.join(OUT, "in_wide_music.wav"))):
        print("wrote", p)


if __name__ == "__main__":
    main()
