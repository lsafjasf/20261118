"""Bundle the interactive map viewer into a single self-contained HTML file.

Embeds:
  * src/web/audio_metrics.js        (browser DSP, cross-checked vs Python)
  * src/web/viewer.template.html    (UI + canvas rendering + interaction)
  * artifacts/metrics.json          (reference full-track analysis)
  * artifacts/test_track.wav        (base64, decoded by Web Audio for audition)

Output: artifacts/viewer.html  (open directly or serve over http://localhost)
"""

from __future__ import annotations

import base64
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "src", "web")
ART = os.path.join(ROOT, "artifacts")


def main() -> None:
    with open(os.path.join(WEB, "audio_metrics.js"), "r", encoding="utf-8") as fh:
        dsp_js = fh.read()
    with open(os.path.join(WEB, "viewer_app.js"), "r", encoding="utf-8") as fh:
        app_js = fh.read()
    with open(os.path.join(WEB, "viewer.template.html"), "r", encoding="utf-8") as fh:
        template = fh.read()
    with open(os.path.join(ART, "metrics.json"), "r", encoding="utf-8") as fh:
        metrics_json = fh.read()
    with open(os.path.join(ART, "test_track.wav"), "rb") as fh:
        wav_b64 = base64.b64encode(fh.read()).decode("ascii")

    def assemble(wav_token: str) -> str:
        return (
            template
            .replace("/*__AUDIO_METRICS_JS__*/", dsp_js)
            .replace("/*__VIEWER_APP_JS__*/", app_js)
            .replace('"__METRICS_JSON__"', metrics_json)
            .replace("__WAV_BASE64__", wav_token)
        )

    # Lightweight default: fetches the sibling WAV over HTTP (see serve.py).
    light = assemble("")
    out = os.path.join(ART, "viewer.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(light)
    print(f"wrote {out} ({os.path.getsize(out) / 1e3:.1f} KB, loads test_track.wav over HTTP)")

    # Optional fully self-contained build with embedded base64 audio.
    standalone = assemble(wav_b64)
    out_standalone = os.path.join(ART, "viewer.standalone.html")
    with open(out_standalone, "w", encoding="utf-8") as fh:
        fh.write(standalone)
    print(f"wrote {out_standalone} ({os.path.getsize(out_standalone) / 1e6:.2f} MB, self-contained)")


if __name__ == "__main__":
    main()
