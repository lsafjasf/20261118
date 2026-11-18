"""Optional Tkinter GUI for desktop Python builds that ship Tk.

The headless environment used for development has no Tk support, so this
module is imported lazily and never required by the core engine or tests.
"""

from __future__ import annotations

from .engine import CHANNELS, DownmixConfig, downmix
from .meters import analyze
from .wavio import read_wav, write_wav


def launch(input_path: str, output_path: str | None = None):  # pragma: no cover
    import tkinter as tk
    from tkinter import filedialog, messagebox

    samples, rate, nch = read_wav(input_path)
    if nch != 6:
        raise ValueError("Tk GUI requires a 6-channel 5.1 input")

    config = DownmixConfig()
    root = tk.Tk()
    root.title("5.1 -> Stereo Downmixer")

    gain_vars = {}
    state_vars = {}

    def recompute(*_args):
        for name in CHANNELS:
            config.gain_db[name] = float(gain_vars[name].get())
        config.dialogue_protection_db = float(dialogue_var.get())
        stereo, _ = downmix(samples, 6, config)
        result = analyze(samples, 6, stereo, config)
        for stat in result["input_stats"]:
            state_vars[stat.name].set(
                "RMS %.1f dBFS  peak %.1f  clips %d"
                % (stat.rms_db, stat.peak_db, stat.clip_count)
            )
        corr.set("L/R correlation %+.2f" % result["stereo_correlation"])
        dominance.set(
            "centre dominance %.0f%%" % (result["center_dominance"] * 100.0)
        )
        retention.set(
            "surround retention %.0f%% / cancellation %.2f"
            % (
                result["surround_retention"] * 100.0,
                result["surround_cancellation"],
            )
        )
        warning_text.set(
            "\n".join(result["warnings"]) if result["warnings"]
            else "no diagnostic warnings"
        )
        root._last_stereo = stereo

    def toggle_solo(name):
        if name in config.solo:
            config.solo.remove(name)
        else:
            config.solo.add(name)
        recompute()

    def toggle_mute(name):
        if name in config.muted:
            config.muted.remove(name)
        else:
            config.muted.add(name)
        recompute()

    for row, name in enumerate(CHANNELS):
        tk.Label(root, text=name, width=6).grid(row=row, column=0, sticky="w")
        gain_var = tk.StringVar(value="%.1f" % config.gain_db[name])
        gain_vars[name] = gain_var
        tk.Spinbox(
            root, from_=-40, to=12, increment=0.5, width=6,
            textvariable=gain_var, command=recompute,
        ).grid(row=row, column=1)
        state_var = tk.StringVar()
        state_vars[name] = state_var
        tk.Label(root, textvariable=state_var, width=34, anchor="w").grid(
            row=row, column=2
        )
        tk.Button(root, text="Solo",
                  command=lambda n=name: toggle_solo(n)).grid(row=row, column=3)
        tk.Button(root, text="Mute",
                  command=lambda n=name: toggle_mute(n)).grid(row=row, column=4)

    dialogue_row = len(CHANNELS) + 1
    tk.Label(root, text="dialogue protection dB").grid(
        row=dialogue_row, column=0, columnspan=2, sticky="w"
    )
    dialogue_var = tk.StringVar(value="0.0")
    tk.Spinbox(
        root, from_=0, to=12, increment=0.5, width=6,
        textvariable=dialogue_var, command=recompute,
    ).grid(row=dialogue_row, column=2, sticky="w")

    corr = tk.StringVar()
    dominance = tk.StringVar()
    retention = tk.StringVar()
    warning_text = tk.StringVar()
    metric_row = dialogue_row + 2
    for offset, variable in enumerate((corr, dominance, retention)):
        tk.Label(root, textvariable=variable, width=42, anchor="w").grid(
            row=metric_row + offset, column=0, columnspan=5, sticky="w"
        )
    tk.Label(
        root, textvariable=warning_text, fg="#a33", width=60, anchor="w",
    ).grid(row=metric_row + 3, column=0, columnspan=5, sticky="w")

    def save_output():
        path = output_path or filedialog.asksaveasfilename(
            defaultextension=".wav"
        )
        if path:
            write_wav(path, root._last_stereo, rate, 2)
            messagebox.showinfo("saved", path)

    tk.Button(root, text="Save stereo WAV", command=save_output).grid(
        row=metric_row + 5, column=0, columnspan=2
    )
    root._last_stereo = []
    recompute()
    root.mainloop()
