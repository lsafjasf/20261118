"""Video frames must be scheduled on the re-timed (media-clock) axis."""
import numpy as np

from player.devices import SimulatedDevice
from player.engine import Player
from player.media import VideoTrack, speech_track

SR = 44100
FPS = 30.0


def make_player(duration=30.0, speeds=(0.5, 1.0, 2.0, 1.5)):
    audio = speech_track(SR, duration)
    video = VideoTrack(FPS, duration)
    player = Player(audio, video, SimulatedDevice(SR), SR,
                    speeds=speeds, switch_interval=5.0)
    player.run()
    return player, video


def test_frame_ids_are_nondecreasing():
    player, _ = make_player()
    ids = [e.frame_id for e in player.frame_events]
    assert all(b >= a for a, b in zip(ids, ids[1:]))


def test_frame_matches_media_clock_at_display_time():
    player, video = make_player()
    for e in player.frame_events:
        assert e.frame_id == video.frame_at(e.media_seconds)


def test_all_frames_shown_exactly_once_at_low_speed():
    audio = speech_track(SR, 10.0)
    video = VideoTrack(FPS, 10.0)
    player = Player(audio, video, SimulatedDevice(SR), SR,
                    speeds=(0.5,), switch_interval=1e9)
    player.set_speed(0.5)
    player.run()
    ids = [e.frame_id for e in player.frame_events]
    assert ids == list(range(video.frame_count))


def test_high_speed_drops_but_never_repeats_earlier_frames():
    audio = speech_track(SR, 10.0)
    video = VideoTrack(FPS, 10.0)
    player = Player(audio, video, SimulatedDevice(SR), SR,
                    speeds=(2.0,), switch_interval=1e9)
    player.set_speed(2.0)
    player.run()
    ids = [e.frame_id for e in player.frame_events]
    assert all(b > a for a, b in zip(ids, ids[1:]))
    assert ids[-1] == video.frame_count - 1
