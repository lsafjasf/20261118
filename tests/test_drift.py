"""Ten-minute endurance: speed switches every 5 s, measure drift."""
import numpy as np
import pytest
from scipy.signal import find_peaks

from player.devices import SimulatedDevice
from player.engine import Player
from player.media import VideoTrack, beat_track, speech_track

SR = 44100
DURATION = 600.0
SPEEDS = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
BPM = 120.0


def run_player(audio, ppm=0.0):
    video = VideoTrack(30.0, DURATION)
    device = SimulatedDevice(SR, ppm=ppm)
    player = Player(audio, video, device, SR, speeds=SPEEDS,
                    switch_interval=5.0)
    player.keep_audio = True
    player.run()
    out = np.concatenate(player.rendered)[:, 0]
    return player, out


@pytest.fixture(scope="module")
def speech_run():
    return run_player(speech_track(SR, DURATION))


@pytest.fixture(scope="module")
def beat_run():
    return run_player(beat_track(SR, DURATION, BPM), ppm=50.0)


def test_speech_no_holes(speech_run):
    player, out = speech_run
    nz = np.nonzero(np.abs(out) > 1e-9)[0]
    max_run = _max_zero_run(out[nz[0] : nz[-1]])
    # longest legitimate hole = longest source pause stretched by 0.5x
    limit = 2 * _max_zero_run(player.audio) + 4096
    print(f"\nspeech: longest zero run {max_run} samples "
          f"(allowed up to {limit})")
    assert max_run <= limit, "unexpected hole inside rendered speech"


def _max_zero_run(x, thresh=1e-9):
    z = (np.abs(x) < thresh).astype(np.int8)
    d = np.diff(np.concatenate(([0], z, [0])))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return int((ends - starts).max()) if starts.size else 0


def test_speech_no_repeated_words(speech_run):
    player, _ = speech_run
    ks = np.array([k for _, k in player.stretcher.trace])
    assert (np.diff(ks) >= 0).all(), "input cursor moved backwards"
    max_jump = player.stretcher.hop * 2.0 + 2 * player.stretcher.search
    assert np.diff(ks).max() <= max_jump, "input cursor skipped forward"


def test_speech_cumulative_drift_after_10min(speech_run):
    player, out = speech_run
    # sample-accurate: WSOLA cursor vs speed schedule over the whole run
    tr = np.array(player.stretcher.trace)
    expected = np.array(
        [player.schedule.media_time_at(int(o)) * SR for o in tr[:, 0]])
    dev_ms = (tr[:, 1] - expected) / SR * 1000.0
    print(f"\nspeech trace-vs-schedule: max|dev|={np.abs(dev_ms).max():.2f} ms "
          f"final dev={dev_ms[-1]:+.2f} ms")
    assert np.abs(dev_ms).max() < 20.0

    # acoustic end-to-end: raw-waveform correlation inside 1.0x segments
    from scipy.signal import correlate

    src = player.audio
    lags = []
    nccs = []
    prev = 0
    tail = [(1 << 60, player.schedule.current_speed)]
    for at, speed in player.schedule._segments + tail:
        if abs(speed - 1.0) < 1e-9 and at - prev > 3 * SR:
            o = prev + SR  # 1 s inside the segment
            exp = int(player.schedule.media_time_at(o) * SR)
            if exp + SR > len(src):
                break  # too close to the end of the source
            seg = out[o : o + SR // 2]
            if np.sqrt(np.mean(seg ** 2)) < 0.01:
                continue  # segment sits in a long pause; nothing to match
            lo = max(exp - SR // 3, 0)
            hi = min(exp + SR // 3 + len(seg), len(src))
            corr = correlate(src[lo:hi], seg, mode="valid", method="fft")
            j = int(np.argmax(corr))
            ncc = corr[j] / (np.linalg.norm(seg)
                             * np.linalg.norm(src[lo + j : lo + j + len(seg)]))
            nccs.append(ncc)
            lags.append((lo + j - exp) / SR * 1000.0)
        prev = at
    print(f"speech segment match ncc: {[round(x, 3) for x in nccs]}")
    # WSOLA re-aligns within its search window, so waveform-level NCC in
    # highly periodic syllables is naturally < 1; position is what matters.
    assert min(nccs) > 0.4, "rendered speech does not match the source"
    print(f"speech acoustic drift per 1x segment (ms): "
          f"{[round(x, 1) for x in lags]}")
    print(f"speech cumulative drift after 10 min: {lags[-1]:+.2f} ms")
    assert all(abs(x) < 50.0 for x in lags)


def test_beats_all_present_exactly_once(beat_run):
    _, out = beat_run
    env = np.convolve(np.abs(out), np.ones(256) / 256, mode="same")
    peaks, _ = find_peaks(env, height=0.05, distance=int(0.15 * SR))
    expected_beats = int(DURATION * BPM / 60.0)
    assert len(peaks) == expected_beats, (
        f"{len(peaks)} beats detected, {expected_beats} expected: "
        "a beat was dropped or duplicated")


def test_beats_cumulative_drift_after_10min(beat_run):
    player, out = beat_run
    env = np.convolve(np.abs(out), np.ones(256) / 256, mode="same")
    peaks, _ = find_peaks(env, height=0.05, distance=int(0.15 * SR))
    media_times = np.array(
        [player.schedule.media_time_at(int(p)) for p in peaks])
    expected = np.arange(len(peaks)) * 60.0 / BPM
    err_ms = (media_times - expected) * 1000.0
    print(f"\nbeats: n={len(peaks)} max|err|={np.abs(err_ms).max():.2f} ms "
          f"mean|err|={np.abs(err_ms).mean():.2f} ms "
          f"cumulative drift after 10 min={err_ms[-1]:+.2f} ms")
    assert np.abs(err_ms).max() < 50.0
    assert abs(err_ms[-1]) < 50.0
