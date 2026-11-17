"""Speed schedule mapping between output samples and media time."""

from player.clocks import SpeedSchedule


def test_piecewise_mapping_uses_segment_speed_not_current_speed():
    sr = 44100
    s = SpeedSchedule(sr)
    s.set_speed(0.75, 5 * sr)
    s.set_speed(1.0, 10 * sr)
    s.set_speed(2.0, 15 * sr)
    assert s.media_time_at(2 * sr) == 2.0
    assert s.media_time_at(5 * sr) == 5.0
    assert abs(s.media_time_at(int(7.5 * sr)) - 6.875) < 1e-9
    assert abs(s.media_time_at(12 * sr) - 10.75) < 1e-9
    assert abs(s.media_time_at(20 * sr) - 23.75) < 1e-9


def test_mapping_is_monotonic_across_switches():
    sr = 44100
    s = SpeedSchedule(sr)
    for i, speed in enumerate((0.5, 2.0, 0.75, 1.5, 1.0), start=1):
        s.set_speed(speed, i * sr)
    times = [s.media_time_at(k * 1000) for k in range(6 * sr // 1000)]
    assert all(b >= a for a, b in zip(times, times[1:]))
