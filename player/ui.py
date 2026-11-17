"""Terminal UI: media clock, audio hardware clock, delta, speed."""
from __future__ import annotations

import argparse
import time

from .devices import RealtimeNullDevice, SimulatedDevice
from .engine import Player, Status
from .media import VideoTrack, speech_track

SPEEDS = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0)


def fmt(seconds: float) -> str:
    sign = "-" if seconds < 0 else ""
    seconds = abs(seconds)
    return f"{sign}{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def line(s: Status) -> str:
    return (f"media {fmt(s.media_clock)} | audio-hw {fmt(s.audio_clock)} | "
            f"delta {s.delta:+8.3f}s | speed {s.speed:4.2f}x | "
            f"frame {s.frame_id}")


def run_curses(player: Player) -> None:
    import curses

    def loop(scr) -> None:
        curses.curs_set(0)
        scr.nodelay(True)
        done = False
        while not done:
            started = time.monotonic()
            for _ in range(20):  # ~0.46 s of audio per UI refresh
                if not player.step():
                    done = True
                    break
            s = player.status()
            scr.erase()
            scr.addstr(1, 2, "variable-speed player (q to quit)")
            scr.addstr(3, 2, f"media clock       : {fmt(s.media_clock)}")
            scr.addstr(4, 2, f"audio hw clock    : {fmt(s.audio_clock)}")
            scr.addstr(5, 2, f"delta (media-hw)  : {s.delta:+.3f} s")
            scr.addstr(6, 2, f"speed             : {s.speed:.2f}x")
            scr.addstr(7, 2, f"video frame       : {s.frame_id}")
            scr.refresh()
            if scr.getch() == ord("q"):
                break
            delay = started + 0.4 - time.monotonic()
            if delay > 0:
                time.sleep(delay)

    curses.wrapper(loop)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--duration", type=float, default=600.0)
    ap.add_argument("--switch-interval", type=float, default=5.0)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--fast", action="store_true",
                    help="virtual clock, no sleeping")
    ap.add_argument("--sample-rate", type=int, default=44100)
    args = ap.parse_args()

    sr = args.sample_rate
    audio = speech_track(sr, args.duration)
    video = VideoTrack(30.0, args.duration)
    device = SimulatedDevice(sr) if args.fast else RealtimeNullDevice(sr)
    player = Player(audio, video, device, sr, speeds=SPEEDS,
                    switch_interval=args.switch_interval)

    if args.headless or args.fast:
        last = [0.0]

        def on_status(s: Status) -> None:
            if s.audio_clock - last[0] >= 1.0:
                last[0] = s.audio_clock
                print(line(s), flush=True)

        player.run(on_status, status_every=10)
        print("final:", line(player.status()))
    else:
        run_curses(player)


if __name__ == "__main__":
    main()
