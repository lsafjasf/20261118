"""Generate three test tracks: constant BPM, accelerando, free tempo.

All tracks contain kick-drum-like transients at ground-truth attack times so
that onset detection has a clear target. Ground truth is written alongside the
audio as JSON for evaluation.
"""

import argparse
import json
import os

import numpy as np

SR = 44100


def write_wav(path, audio, sr=SR):
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767).astype("<i2")
    data = pcm.tobytes()
    import wave

    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(data)


def kick(sr=SR, dur=0.18, f0=110.0):
    n = int(sr * dur)
    t = np.arange(n) / sr
    freq = f0 * np.exp(-t * 18.0) + 45.0
    phase = 2 * np.pi * np.cumsum(freq) / sr
    env = np.exp(-t * 22.0)
    return np.sin(phase) * env


def hat(sr=SR, dur=0.05):
    rng = np.random.default_rng(0)
    n = int(sr * dur)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    env = np.exp(-t * 90.0)
    return 0.35 * noise * env


def place(canvas, sample_pos, sound, gain=0.9):
    end = min(len(canvas), sample_pos + len(sound))
    canvas[sample_pos:end] += gain * sound[: end - sample_pos]


def ambience(duration, sr=SR, seed=1):
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    base = rng.standard_normal(n) * 0.004
    t = np.arange(n) / sr
    base += 0.012 * np.sin(2 * np.pi * 220 * t)
    return base


def render(times, half_times=(), seed=1, gain=0.95):
    duration = max(times) + 1.2
    canvas = ambience(duration, seed=seed)
    k = kick()
    h = hat()
    for bt in times:
        place(canvas, int(bt * SR), k, gain)
    for bt in half_times:
        place(canvas, int(bt * SR), h, gain * 0.6)
    return canvas, duration


def scene_constant():
    bpm = 100.0
    beat = 60.0 / bpm
    n_beats = 32
    times = [0.5 + i * beat for i in range(n_beats)]
    halves = [t + beat / 2 for t in times[:-1]]
    meta = {
        "scene": "constant",
        "description": "32 beats at fixed 100 BPM, eighth-note hats",
        "bpm_curve": [[0.5, bpm], [times[-1], bpm]],
        "ground_truth_beats": times,
    }
    return times, halves, meta


def scene_accelerando():
    bpm0, bpm1 = 80.0, 140.0
    n_beats = 32
    t0 = 0.6
    span = n_beats - 1
    # Exponential BPM bpm(i) = bpm0 * r^i, r = (bpm1/bpm0)^(1/span).
    # Beat i starts after accumulating periods 60/bpm(0..i-1).
    r = (bpm1 / bpm0) ** (1.0 / span)
    times = [
        t0 + float(np.sum([60.0 / (bpm0 * r**j) for j in range(i)]))
        for i in range(n_beats)
    ]
    halves = [
        0.5 * (times[i] + times[i + 1]) for i in range(n_beats - 1)
    ]
    bpms = np.geomspace(bpm0, bpm1, n_beats)
    meta = {
        "scene": "accelerando",
        "description": "32 beats ramping 80 -> 140 BPM (exponential)",
        "bpm_curve": [[times[i], float(bpms[i])] for i in range(n_beats)],
        "ground_truth_beats": times,
    }
    return times, halves, meta


def scene_free():
    rng = np.random.default_rng(42)
    n_beats = 24
    base_period = 0.6
    jitter = rng.uniform(-0.16, 0.16, n_beats)
    rubato = 0.08 * np.sin(np.linspace(0, 3.2 * np.pi, n_beats))
    periods = np.maximum(0.32, base_period + jitter + rubato)
    times = list(np.cumsum(np.concatenate([[0.8], periods[:-1]])))
    meta = {
        "scene": "free",
        "description": "24 attacks with uncorrelated timing, no steady pulse",
        "bpm_curve": [[times[i], float(60.0 / periods[i])] for i in range(n_beats)],
        "ground_truth_beats": times,
    }
    return times, (), meta


SCENES = {
    "constant": scene_constant,
    "accelerando": scene_accelerando,
    "free": scene_free,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "audio"))
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    for name, fn in SCENES.items():
        times, halves, meta = fn()
        audio, duration = render(times, halves, seed=hash(name) & 0xFFFF)
        wav_path = os.path.join(out, f"{name}.wav")
        json_path = os.path.join(out, f"{name}.truth.json")
        write_wav(wav_path, audio)
        meta["duration"] = duration
        meta["sample_rate"] = SR
        meta["audio"] = os.path.basename(wav_path)
        with open(json_path, "w") as f:
            json.dump(meta, f, indent=2)
        print(f"{name}: {len(times)} beats -> {wav_path}")


if __name__ == "__main__":
    main()

