"""Interactive seam viewer.

Two stacked panels show the waveform and spectrogram around the candidate
seam. The slider (or click/drag on either panel) moves the seam; the vertical
seam line and horizontal crosshair meet at a single cross point, while the
playback cursor sweeps independently and wraps at the seam. Audio playback is
optional: ``sounddevice`` is used when PortAudio is available, otherwise the
app still runs and can export a tiled loop preview for external listening.
"""

from __future__ import annotations

import time
from pathlib import Path

import matplotlib

import numpy as np
import soundfile as sf
from scipy import signal

from .analyze import evaluate_seam, estimate_beat_period
from .repair import loop_crossfade, write_looped_preview

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - PortAudio missing in CI containers
    sd = None


class SeamViewer:
    def __init__(self, path: str | Path, sr: int, initial_seam: int,
                 context_ms: float = 250.0, fade_ms: float = 20.0):
        self.x, file_sr = sf.read(path, dtype="float64")
        if self.x.ndim == 2:
            self.x = self.x.mean(axis=1)
        if file_sr != sr:
            raise ValueError("sample rate mismatch")
        self.sr = sr
        self.seam = int(np.clip(initial_seam, 1, self.x.size - 1))
        self.context = int(context_ms / 1000.0 * sr)
        self.fade = int(fade_ms / 1000.0 * sr)
        self.source_path = Path(path)
        self.playing = False
        self._syncing = False
        self._stream = None
        self._phase = 0.0
        self._last_tick = None
        self._build()
        self.refresh()

    def _build(self) -> None:
        import matplotlib.pyplot as plt
        if matplotlib.get_backend().lower() == "agg":
            pass  # headless environment: widgets render but do not block.
        else:
            for backend in ("TkAgg", "QtAgg", "GTK4Agg"):
                try:
                    matplotlib.use(backend, force=False)
                    break
                except Exception:
                    continue
        from matplotlib.widgets import Button, Slider

        self.fig, (self.ax_wave, self.ax_spec) = plt.subplots(
            2, 1, figsize=(11, 7), height_ratios=[1, 1.4])
        self.fig.subplots_adjust(bottom=0.20, hspace=0.35)

        self.wave_line, = self.ax_wave.plot([], [], lw=0.7, color="#3366cc")
        self.seam_v_w = self.ax_wave.axvline(0, color="#d62728", lw=1.4)
        self.seam_h_w = self.ax_wave.axhline(0, color="#d62728",
                                             lw=0.8, ls="--", alpha=0.6)
        self.play_v_w = self.ax_wave.axvline(0, color="#2ca02c", lw=1.2)
        self.ax_wave.set_title("Waveform around seam (red = seam, green = play)")
        self.ax_wave.set_xlabel("sample")

        self.spec_img = self.ax_spec.imshow(
            np.zeros((10, 10)), origin="lower", aspect="auto",
            cmap="magma", interpolation="nearest")
        self.seam_v_s = self.ax_spec.axvline(0, color="#d62728", lw=1.4)
        self.seam_h_s = self.ax_spec.axhline(0, color="#d62728",
                                             lw=0.8, ls="--", alpha=0.6)
        self.play_v_s = self.ax_spec.axvline(0, color="#2ca02c", lw=1.2)
        self.ax_spec.set_title("Spectrogram around seam")
        self.ax_spec.set_xlabel("sample")

        ax_slider = self.fig.add_axes([0.08, 0.10, 0.82, 0.03])
        margin = max(64, self.context)
        self.slider = Slider(ax_slider, "seam", margin, self.x.size - margin,
                             valinit=self.seam, valstep=1,
                             initcolor="none")
        self.slider.on_changed(self._on_slider)

        ax_play = self.fig.add_axes([0.08, 0.03, 0.16, 0.05])
        ax_export = self.fig.add_axes([0.27, 0.03, 0.20, 0.05])
        ax_snap = self.fig.add_axes([0.50, 0.03, 0.20, 0.05])
        self.btn_play = Button(ax_play, "Play loop")
        self.btn_export = Button(ax_export, "Write repaired WAV")
        self.btn_snap = Button(ax_snap, "Snap to beat")
        self.btn_play.on_clicked(self.toggle_play)
        self.btn_export.on_clicked(self.export_repaired)
        self.btn_snap.on_clicked(self.snap_to_beat)
        for ax in (self.ax_wave, self.ax_spec):
            ax.callbacks.connect("xlim_changed", self._on_pan)
            self.fig.canvas.mpl_connect("button_press_event",
                                        self._on_click)
        self.status = self.fig.text(
            0.08, 0.155, "", fontsize=9, family="monospace",
            bbox=dict(boxstyle="round", fc="#f4f4f4", ec="#999"))
        self.fig.canvas.new_timer(interval=40).add_callback(self._tick)

    def _on_slider(self, value: float) -> None:
        self.seam = int(round(value))
        self.refresh()

    def _on_click(self, event) -> None:
        if event.inaxes not in (self.ax_wave, self.ax_spec):
            return
        if event.xdata is None or event.button != 1:
            return
        self.seam = int(np.clip(event.xdata, 1, self.x.size - 1))
        self.slider.set_val(self.seam)

    def _on_pan(self, _event=None) -> None:
        if self._syncing:
            return
        self._syncing = True
        lo, hi = self.ax_wave.get_xlim()
        self.ax_spec.set_xlim(lo, hi)
        self.refresh(redraw_spec=False)
        self._syncing = False

    def snap_to_beat(self, _event=None) -> None:
        beat, bpm = estimate_beat_period(self.x, self.sr)
        k = round(self.seam / beat)
        target = int(np.clip(k * beat, beat, self.x.size - beat))
        self.slider.set_val(target)

    def export_repaired(self, _event=None) -> None:
        out = Path("artifacts/repaired") / f"{self.source_path.stem}_repaired.wav"
        loop = loop_crossfade(self.x, self.seam, self.fade)
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, loop.astype(np.float32), self.sr)
        preview = out.with_name(out.stem + "_preview4x.wav")
        write_looped_preview(loop, self.sr, preview)
        print(f"wrote {out} and {preview}")

    def toggle_play(self, _event=None) -> None:
        if self.playing:
            self._stop_playback()
            return
        loop = loop_crossfade(self.x, self.seam, self.fade)
        if sd is None:
            preview = Path("artifacts/repaired/headless_preview4x.wav")
            write_looped_preview(loop, self.sr, preview)
            print(f"PortAudio unavailable; wrote {preview} instead")
            return
        self._loop = loop
        self._phase = 0.0
        self._last_tick = time.perf_counter()
        self._stream = sd.OutputStream(
            samplerate=self.sr, channels=1, callback=self._audio_cb,
            blocksize=1024)
        self._stream.start()
        self.playing = True
        self.btn_play.label.set_text("Stop")

    def _audio_cb(self, outdata, frames, _time_info, _status) -> None:
        n = self._loop.size
        idx = int(self._phase) % n
        chunk = np.roll(self._loop, -idx)[:frames]
        if chunk.size < frames:
            chunk = np.resize(self._loop, frames)
        outdata[:, 0] = chunk
        self._phase = (self._phase + frames) % n

    def _stop_playback(self) -> None:
        self.playing = False
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        self.btn_play.label.set_text("Play loop")

    def _tick(self) -> None:
        if not self.playing:
            return
        now = time.perf_counter()
        if self._last_tick is None:
            self._last_tick = now
        dt = now - self._last_tick
        self._last_tick = now
        self._phase = (self._phase + dt * self.sr) % self._loop.size
        self._update_play_cursor()
        self.fig.canvas.draw_idle()

    def _update_play_cursor(self) -> None:
        pos = self.seam - self._loop.size + self._phase
        self.play_v_w.set_xdata([pos, pos])
        self.play_v_s.set_xdata([pos, pos])

    def refresh(self, redraw_spec: bool = True) -> None:
        half = self.context
        lo = max(0, self.seam - half)
        hi = min(self.x.size, self.seam + half)
        t = np.arange(lo, hi)
        self.wave_line.set_data(t, self.x[lo:hi])
        self.ax_wave.set_xlim(lo, hi)
        self.ax_wave.relim()
        self.ax_wave.autoscale_view(scalex=False)

        report = evaluate_seam(self.x, self.sr, self.seam)
        amp = max(np.max(np.abs(self.x[lo:hi])), 1e-6)
        self.seam_v_w.set_xdata([self.seam, self.seam])
        self.seam_h_w.set_ydata([amp * 0.62])
        self.seam_v_s.set_xdata([self.seam, self.seam])
        self.status.set_text(
            f"seam={self.seam} ({self.seam/self.sr:.6f}s)  "
            f"dRMS={report.sample_diff_rms:.4f}  "
            f"peak|d|={report.sample_diff_peak:.4f}  "
            f"dphase={report.phase_jump_rad:.3f}rad  "
            f"coh={report.phase_coherence:.3f}  "
            f"transient_break={report.transient_break:.3f}  "
            f"cost={report.combined_cost:.4f}")

        if redraw_spec:
            seg = self.x[lo:hi]
            f, tt, z = signal.spectrogram(
                seg, fs=self.sr, nperseg=1024, noverlap=896,
                scaling="spectrum", mode="magnitude")
            z = 20 * np.log10(z + 1e-8)
            self.spec_img.set_data(z)
            self.spec_img.set_extent((lo, hi, f[0], f[-1]))
            self.spec_img.set_clim(np.percentile(z, 35), np.percentile(z, 99))
            self.ax_spec.set_ylim(0, 6000)
        self.seam_h_s.set_ydata([1500])
        self.fig.canvas.draw_idle()

    def show(self) -> None:
        import matplotlib.pyplot as plt
        plt.show()

    def save_snapshot(self, out_path: str | Path) -> None:
        """Render the current seam view without entering the GUI loop."""
        self.refresh()
        self.fig.savefig(out_path, dpi=120)


def headless_snapshot(path: str | Path, sr: int, seam: int,
                      out_path: str | Path, fade_ms: float = 20.0) -> None:
    """Build the viewer under a non-interactive backend and save a figure."""
    matplotlib.use("Agg", force=True)
    viewer = SeamViewer(path, sr, seam, fade_ms=fade_ms)
    viewer.save_snapshot(out_path)
