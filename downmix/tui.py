"""Interactive curses console with per-channel meters and fold-down controls.

The string rendering in :func:`render_console` is deliberately free of any
curses calls so it can be unit tested without a terminal.
"""

from __future__ import annotations

import math

from .engine import CHANNELS, DownmixConfig, downmix
from .meters import (
    CENTER_DOMINANCE_WARN,
    SURROUND_RETENTION_WARN,
    analyze,
)

METER_WIDTH = 24


def _meter_bar(level: float, width: int = METER_WIDTH) -> str:
    """Horizontal dB meter bar; 0 dBFS on the right, -60 dBFS on the left."""
    if level <= 0.0:
        filled = 0
    else:
        db = 20.0 * math.log10(level)
        normalized = max(0.0, min(1.0, (db + 60.0) / 60.0))
        filled = int(round(normalized * width))
    bar = "#" * filled + "." * (width - filled)
    if level >= 0.95:
        marker = "CLIP"
    elif level >= 0.707:
        marker = " hot"
    else:
        marker = "    "
    return "[" + bar + "] " + marker


def _gain_label(config: DownmixConfig, name: str) -> str:
    if name in config.muted:
        return "MUTED"
    if config.solo and name in config.solo:
        return "SOLO "
    if config.solo and name not in config.solo:
        return "solo-"
    gain = config.gain_db[name]
    if gain == float("-inf"):
        return "  off"
    label = "%+5.1fdB" % gain
    if name == "C" and config.dialogue_protection_db:
        label += " D+%.1f" % config.dialogue_protection_db
    return label


def render_console(input_stats, output_stats, result, config, position):
    """Pure-function view of the whole console (used by tests and curses)."""
    lines = []
    lines.append(" 5.1 -> Stereo Downmix Console   [frame %d]" % position)
    lines.append(" " + "-" * 62)
    lines.append(" INPUT CHANNELS        level meter                 gain/state")
    for stat in input_stats:
        lines.append(
            "  %-4s %s %s"
            % (stat.name, _meter_bar(stat.peak),
               _gain_label(config, stat.name))
        )
    lines.append(" " + "-" * 62)
    lines.append(" STEREO BUS")
    for stat in output_stats:
        lines.append("  %-5s %s" % (stat.name, _meter_bar(stat.peak)))
    lines.append(" " + "-" * 62)
    lines.append(
        " correlation %+.2f | centre dominance %3.0f%% (warn >= %2.0f%%)"
        % (
            result["stereo_correlation"],
            result["center_dominance"] * 100.0,
            CENTER_DOMINANCE_WARN * 100.0,
        )
    )
    lines.append(
        " surround retention %3.0f%% (warn < %2.0f%%) | cancellation %.2f"
        % (
            result["surround_retention"] * 100.0,
            SURROUND_RETENTION_WARN * 100.0,
            result["surround_cancellation"],
        )
    )
    lines.append(" " + "-" * 62)
    if result["warnings"]:
        for warning in result["warnings"][:4]:
            lines.append(" ! " + warning)
    else:
        lines.append(" no active warnings")
    lines.append(" " + "-" * 62)
    lines.append(
        " keys: 1-6 select channel  +/- gain  d dialogue+  x solo  m mute"
    )
    lines.append("        r reset  s re-run mix  q quit")
    return "\n".join(lines)


def console_snapshot(samples, nch, config):
    """Compute every value the console renders for the whole clip."""
    stereo, _ = downmix(samples, nch, config)
    result = analyze(samples, nch, stereo, config)
    return result, stereo


HELP = (
    "\nInteractive keys:\n"
    "  1..6  select L R C LFE Ls Rs\n"
    "  + / - adjust selected channel gain by 1 dB\n"
    "  d      increase centre dialogue protection by 1 dB (D decreases)\n"
    "  x      solo selected channel (toggle)\n"
    "  m      mute selected channel (toggle)\n"
    "  r      reset gains, solo and mute\n"
    "  q      quit\n"
)


def run_tui(samples, rate, config: DownmixConfig, args):  # pragma: no cover
    try:
        import curses
    except ImportError:
        print("curses is not available in this Python build", file=__import__("sys").stderr)
        return 1

    state = {
        "config": config,
        "selected": 0,
        "result": None,
        "output_path": args.output,
        "rate": rate,
        "pcm": args.pcm,
    }

    def recompute():
        result, stereo = console_snapshot(samples, 6, state["config"])
        state["result"] = result
        state["stereo"] = stereo

    def loop(stdscr):
        curses.curs_set(0)
        stdscr.nodelay(False)
        recompute()
        while True:
            cfg = state["config"]
            result = state["result"]
            view = render_console(
                result["input_stats"], result["output_stats"], result,
                cfg, len(samples) // 6,
            )
            stdscr.erase()
            for row, line in enumerate(view.split("\n")):
                stdscr.addstr(row, 0, line[: curses.COLS - 1])
            stdscr.addstr(
                len(view.split("\n")) + 1, 0,
                "selected: %s" % CHANNELS[state["selected"]],
            )
            stdscr.refresh()
            key = stdscr.getch()
            name = CHANNELS[state["selected"]]
            if key in (ord("q"), ord("Q")):
                break
            if ord("1") <= key <= ord("6"):
                state["selected"] = key - ord("1")
            elif key in (ord("+"), ord("="), curses.KEY_UP):
                cfg.gain_db[name] = min(12.0, cfg.gain_db[name] + 1.0)
            elif key in (ord("-"), ord("_"), curses.KEY_DOWN):
                cfg.gain_db[name] = max(-40.0, cfg.gain_db[name] - 1.0)
            elif key in (ord("d"),):
                cfg.dialogue_protection_db += 1.0
            elif key in (ord("D"),):
                cfg.dialogue_protection_db = max(
                    0.0, cfg.dialogue_protection_db - 1.0
                )
            elif key == ord("x"):
                if name in cfg.solo:
                    cfg.solo.remove(name)
                else:
                    cfg.solo.add(name)
            elif key == ord("m"):
                if name in cfg.muted:
                    cfg.muted.remove(name)
                else:
                    cfg.muted.add(name)
            elif key == ord("r"):
                state["config"] = DownmixConfig()
            elif key == ord("s"):
                from .wavio import write_wav
                if state["output_path"]:
                    write_wav(
                        state["output_path"], state["stereo"],
                        state["rate"], 2, subtype=state["pcm"],
                    )
            else:
                continue
            recompute()

    import curses
    curses.wrapper(loop)
    return 0
