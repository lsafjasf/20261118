#!/usr/bin/env python3
"""PCM <-> FLAC round-trip verifier.

Generates a deterministic multi-segment test signal (transients, silence,
fade-out), writes it as PCM WAV, encodes to FLAC, decodes back to PCM and
verifies bit-exact losslessness, per-channel layout recovery and max error.
Prints byte counts for every step and attempts playback of the result.
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

# FLAC supports up to 24-bit in libsndfile; 32-bit integer PCM is not a
# valid FLAC subtype here, so the tool offers 16 and 24 bit depths.
SUBTYPE_BY_DEPTH = {16: "PCM_16", 24: "PCM_24"}
DTYPE_BY_DEPTH = {16: np.int16, 24: np.int32}


def generate_signal(sample_rate, channels, bit_depth, seed=42):
    """Build transient + silence + fade-out segments, unique per channel."""
    rng = np.random.default_rng(seed)
    segments = []

    # 1. Transients: clicks plus a short noise burst (0.25 s)
    n = int(0.25 * sample_rate)
    trans = np.zeros((n, channels))
    for ch in range(channels):
        click_times = rng.integers(0, n, size=6)
        trans[click_times, ch] = 0.9 * rng.choice([-1.0, 1.0], size=6)
        burst = rng.uniform(-0.4, 0.4, size=int(0.02 * sample_rate))
        start = int(0.1 * sample_rate) + ch * 100
        trans[start:start + len(burst), ch] += burst
    segments.append(trans)

    # 2. Digital silence (0.30 s)
    segments.append(np.zeros((int(0.30 * sample_rate), channels)))

    # 3. Fade-out tones: exponential decay, distinct freq per channel (0.50 s)
    n = int(0.50 * sample_rate)
    t = np.arange(n) / sample_rate
    envelope = np.exp(-6.0 * t)
    fade = np.empty((n, channels))
    for ch in range(channels):
        freq = 220.0 * (ch + 1)
        fade[:, ch] = 0.8 * envelope * np.sin(2 * np.pi * freq * t)
    segments.append(fade)

    signal = np.clip(np.vstack(segments), -1.0, 1.0)

    # Quantize to the target bit depth so the PCM source is exact integers.
    dtype = DTYPE_BY_DEPTH[bit_depth]
    if bit_depth == 24:
        scale = 2 ** 23
        pcm = (np.round(signal * (scale - 1)).astype(np.int64) << 8).astype(dtype)
    else:
        scale = 2 ** (bit_depth - 1)
        pcm = np.round(signal * (scale - 1)).astype(dtype)
    return pcm


def to_int_frames(data, bit_depth):
    """Normalize decoded audio to comparable integer frames."""
    if bit_depth == 24 and data.dtype == np.int32:
        return data.astype(np.int64) >> 8
    return data.astype(np.int64)


def human(n):
    for unit in ("B", "KiB", "MiB"):
        if n < 1024 or unit == "MiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def try_playback(path):
    """Attempt playback with whatever player exists; report the outcome."""
    players = ["ffplay", "aplay", "paplay", "play"]
    for player in players:
        exe = shutil.which(player)
        if not exe:
            continue
        cmd = [exe, str(path)]
        if player == "ffplay":
            cmd = [exe, "-nodisp", "-autoexit", "-loglevel", "error", str(path)]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except Exception as exc:
            return f"player '{player}' failed to run: {exc}"
        if proc.returncode == 0:
            return f"played OK with '{player}'"
        err = (proc.stderr or "").strip().splitlines()
        return f"player '{player}' exited {proc.returncode}: {err[-1] if err else 'no stderr'}"
    return "skipped: no audio player/device available (ffplay/aplay/paplay/play not found)"


def run_roundtrip(bit_depth, channels, sample_rate, outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    subtype = SUBTYPE_BY_DEPTH[bit_depth]
    wav_path = outdir / f"source_{bit_depth}b_{channels}ch_{sample_rate}.wav"
    flac_path = outdir / f"encoded_{bit_depth}b_{channels}ch_{sample_rate}.flac"
    decoded_wav_path = outdir / f"decoded_{bit_depth}b_{channels}ch_{sample_rate}.wav"

    print(f"Config: {bit_depth}-bit, {channels} ch, {sample_rate} Hz")

    # Step 1: generate PCM source
    pcm = generate_signal(sample_rate, channels, bit_depth)
    frames = pcm.shape[0]
    raw_bytes = frames * channels * (bit_depth // 8)
    print(f"[1] Generated PCM: {frames} frames x {channels} ch, "
          f"raw payload = {raw_bytes} B ({human(raw_bytes)})")

    # Step 2: write PCM WAV
    sf.write(wav_path, pcm, sample_rate, subtype=subtype)
    wav_bytes = wav_path.stat().st_size
    print(f"[2] PCM WAV written: {wav_path.name} = {wav_bytes} B ({human(wav_bytes)})")

    # Step 3: encode to FLAC (integer samples written directly, no float
    # conversion, so the encoder receives the exact PCM values).
    sf.write(flac_path, pcm, sample_rate, format="FLAC", subtype=subtype)
    flac_bytes = flac_path.stat().st_size
    ratio = raw_bytes / flac_bytes if flac_bytes else float("inf")
    print(f"[3] FLAC encoded: {flac_path.name} = {flac_bytes} B ({human(flac_bytes)}), "
          f"compression ratio vs raw PCM = {ratio:.2f}x")

    # Step 4: decode FLAC back to PCM
    decoded, dec_sr = sf.read(flac_path, dtype=DTYPE_BY_DEPTH[bit_depth].__name__,
                              always_2d=True)
    sf.write(decoded_wav_path, decoded, dec_sr, subtype=subtype)
    decoded_bytes = decoded_wav_path.stat().st_size
    print(f"[4] FLAC decoded: {decoded.shape[0]} frames, "
          f"decoded WAV = {decoded_bytes} B ({human(decoded_bytes)})")

    # Step 5: metadata / channel-layout verification
    src_info = sf.info(wav_path)
    flac_info = sf.info(flac_path)
    layout_ok = (
        flac_info.channels == channels
        and flac_info.samplerate == sample_rate
        and flac_info.frames == frames
    )
    print(f"[5] Metadata: src {src_info.channels}ch@{src_info.samplerate}Hz "
          f"-> flac {flac_info.channels}ch@{flac_info.samplerate}Hz, "
          f"frames {flac_info.frames}/{frames}, "
          f"channel layout {'PRESERVED' if layout_ok else 'MISMATCH'}")

    # Step 6: sample-by-sample comparison
    ref = to_int_frames(pcm, bit_depth)
    got = to_int_frames(decoded, bit_depth)
    if ref.shape != got.shape:
        print(f"[6] FAIL: shape mismatch {ref.shape} vs {got.shape}")
        return False
    diff = np.abs(ref - got)
    max_err = int(diff.max())
    mismatches = int(np.count_nonzero(diff))
    per_channel_max = [int(diff[:, ch].max()) for ch in range(channels)]
    lossless = mismatches == 0
    print(f"[6] Sample check: {ref.size} samples compared, "
          f"mismatches = {mismatches}, max error = {max_err}, "
          f"per-channel max err = {per_channel_max}")
    print(f"    Lossless round-trip: {'PASS' if lossless else 'FAIL'}")

    # Step 7: per-channel identity (detects swapped/mixed channels)
    channel_ok = all(
        np.array_equal(ref[:, ch], got[:, ch]) for ch in range(channels)
    )
    print(f"[7] Per-channel layout recovery: {'PASS' if channel_ok else 'FAIL'}")

    # Step 8: playback
    print(f"[8] Playback of decoded file: {try_playback(decoded_wav_path)}")

    return lossless and layout_ok and channel_ok


def main():
    parser = argparse.ArgumentParser(description="PCM <-> FLAC round-trip verifier")
    parser.add_argument("--bit-depth", type=int, choices=sorted(SUBTYPE_BY_DEPTH), default=16)
    parser.add_argument("--channels", type=int, default=2)
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--outdir", default="artifacts/roundtrip")
    args = parser.parse_args()

    ok = run_roundtrip(args.bit_depth, args.channels, args.sample_rate, args.outdir)
    print(f"RESULT: {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
