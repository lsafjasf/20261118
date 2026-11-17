"""Automated checks for the stereo width chain.

Covers: mono source, anti-phase segment, wide music, peak safety,
width limiting under low correlation, automation smoothness, and
that the mid channel is preserved (no swap/mono-copy tricks).
"""

import os
import wave
import xml.etree.ElementTree as ET

import stereo_width as sw
from run_demo import width_automation, process_file, ART, CEILING_DB

CEILING = 10.0 ** (CEILING_DB / 20.0)
PASS = []


def check(label, ok, detail=""):
    PASS.append(ok)
    print("%s %-58s %s" % ("PASS" if ok else "FAIL", label, detail))


def valid_wav(path, channels):
    with wave.open(path, "rb") as wf:
        return wf.getnchannels() == channels and wf.getnframes() > 0


def main():
    results = {}
    for name in ("mono", "antiphase", "wide_music"):
        res, st = process_file(name)
        results[name] = (res, st)
        out = os.path.join(ART, "out_%s.wav" % name)
        check("%s: output WAV exists, stereo, non-empty" % name,
              os.path.exists(out) and valid_wav(out, 2))
        check("%s: output peak within %.1f dBFS ceiling" % (name,
              CEILING_DB),
              st["out_peak_db"] <= CEILING_DB + 0.01,
              "peak=%.3f dBFS" % st["out_peak_db"])

    # --- mono source: stays dual-mono, no fake widening
    res, st = results["mono"]
    l, r = res["left"], res["right"]
    max_lr = max(abs(a - b) for a, b in zip(l, r))
    check("mono: output remains dual-mono (L == R)", max_lr < 1e-6,
          "max|L-R|=%.2e" % max_lr)
    check("mono: correlation stays 1.0", st["out_corr"] > 0.999,
          "corr=%.4f" % st["out_corr"])

    # --- anti-phase segment: widening must be suppressed 3.2s..4.8s
    res, st = results["antiphase"]
    seg = [w for t, w in zip(res["times"], res["applied_width"])
           if 3.2 <= t <= 4.8]
    check("antiphase: width limited to <=1.0 in out-of-phase segment",
          max(seg) <= 1.02, "max applied width=%.3f" % max(seg))
    seg_in = [w for t, w in zip(res["times"], res["applied_width"])
              if t < 2.0]
    check("antiphase: widening allowed when in-phase",
          max(seg_in) > 1.5, "max applied width=%.3f" % max(seg_in))

    # --- automation smoothness (no zipper / pumping on fast sweeps)
    for name in ("mono", "wide_music"):
        res, _ = results[name]
        w = res["applied_width"]
        dt = res["times"][1] - res["times"][0]
        slew = max(abs(b - a) for a, b in zip(w, w[1:])) / dt
        check("%s: width slew <= 3.5/s (smoothed sweep)" % name,
              slew <= 3.5, "max slew=%.2f/s" % slew)
    # correlation-driven ducks must not create sample-level clicks
    res, _ = results["antiphase"]
    ch, _, _ = sw.read_wav(os.path.join(ART, "in_antiphase.wav"))
    in_step = max(max(abs(b - a) for a, b in zip(c, c[1:])) for c in ch)
    out_step = max(
        max(abs(b - a) for a, b in zip(c, c[1:]))
        for c in (res["left"], res["right"]))
    check("antiphase: no sample-level clicks from width ducking",
          out_step <= max(0.3, 1.5 * in_step),
          "in step=%.3f out step=%.3f" % (in_step, out_step))

    # --- auto gain is smooth and never boosts
    for name in ("mono", "antiphase", "wide_music"):
        res, _ = results[name]
        g = res["gain_db"]
        check("%s: auto gain <= 0 dB (attenuation only)" % name,
              max(g) <= 0.01, "max=%.3f dB" % max(g))

    # --- mid channel preserved (no swap / mono-copy trick)
    res, st = results["wide_music"]
    ch, _, _ = sw.read_wav(os.path.join(ART, "in_wide_music.wav"))
    n = len(res["left"])
    num = den = 0.0
    for i in range(0, n, 10):
        mi = 0.5 * (ch[0][i] + ch[1][i])
        mo = 0.5 * (res["left"][i] + res["right"][i])
        num += mi * mo
        den += mi * mi
    check("wide_music: mid content preserved (gain-tracked)",
          den > 0 and 0.5 < num / den < 1.5,
          "mid ratio=%.3f" % (num / den if den else 0.0))
    check("wide_music: output differs from input (processing active)",
          st["width_min"] < 0.5 or st["min_gain_db"] < -0.1)

    # --- report HTML well-formed
    report = os.path.join(ART, "report.html")
    ok = os.path.exists(report)
    if ok:
        html = open(report).read()
        for frag in ("<svg", "output peak", "correlation", "auto gain"):
            if frag not in html:
                ok = False
        try:
            import re
            for svg in re.findall(r"<svg.*?</svg>", html, re.S):
                ET.fromstring(svg)
        except Exception:
            ok = False
    check("report.html exists, has meters + well-formed SVG charts", ok)

    print("\n%d/%d checks passed" % (sum(PASS), len(PASS)))
    return 0 if all(PASS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
