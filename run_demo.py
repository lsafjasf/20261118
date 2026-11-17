"""Run the stereo width chain on the test files and build an HTML UI
report showing original/processed peaks, correlation and auto gain.

Usage: python3 run_demo.py
Outputs: artifacts/out_*.wav + artifacts/report.html
"""

import os

import stereo_width as sw

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "artifacts")

CEILING_DB = -1.0
CORR_THRESHOLD = 0.0


def width_automation(t):
    """Aggressive user automation: fast triangle sweep 0.2 <-> 2.0.

    Period 2 s, so the requested width sweeps the full range twice
    per 4 s - deliberately fast to prove the smoother kills pumping.
    """
    phase = (t % 2.0) / 2.0
    tri = 1.0 - abs(2.0 * phase - 1.0)
    return 0.2 + 1.8 * tri


def process_file(name):
    src = os.path.join(ART, "in_%s.wav" % name)
    chans, rate, n = sw.read_wav(src)
    mono_upmix = False
    if len(chans) == 1:
        # mono source: honest dual-mono upmix so the chain can run;
        # side channel is silence, widening is a safe no-op.
        chans = [chans[0][:], chans[0][:]]
        mono_upmix = True
    left, right = chans[0], chans[1]

    proc = sw.WidthProcessor(rate, corr_threshold=CORR_THRESHOLD,
                             ceiling_db=CEILING_DB)
    res = proc.process(left, right, width_automation)

    out_path = os.path.join(ART, "out_%s.wav" % name)
    sw.write_wav(out_path, [res["left"], res["right"]], rate,
                 width_bytes=3)

    stats = {
        "name": name,
        "mono_upmix": mono_upmix,
        "rate": rate,
        "duration": res["duration"],
        "in_peak_db": sw.dbfs(sw.peak([left, right])),
        "out_peak_db": sw.dbfs(sw.peak([res["left"], res["right"]])),
        "in_corr": sw.mean_correlation(left, right, rate),
        "out_corr": sw.mean_correlation(res["left"], res["right"], rate),
        "min_gain_db": min(res["gain_db"]),
        "width_min": min(res["applied_width"]),
        "width_max": max(res["applied_width"]),
        "out_path": out_path,
    }
    return res, stats


def svg_chart(series, ymin, ymax, width=660, height=140, unit=""):
    """series: list of (times, values, color, label)."""
    pad_l, pad_r, pad_t, pad_b = 44, 8, 8, 18
    iw = width - pad_l - pad_r
    ih = height - pad_t - pad_b
    t_max = max(t for ts, _, _, _ in series for t in ts)
    parts = ['<svg width="%d" height="%d" viewBox="0 0 %d %d" '
             'xmlns="http://www.w3.org/2000/svg">' % (
                 width, height, width, height)]
    parts.append('<rect width="%d" height="%d" fill="#14181f" rx="6"/>'
                 % (width, height))
    for k in range(5):
        y = pad_t + ih * k / 4.0
        val = ymax - (ymax - ymin) * k / 4.0
        parts.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" '
                     'stroke="#2a3140" stroke-width="1"/>' % (
                         pad_l, y, width - pad_r, y))
        parts.append('<text x="%d" y="%.1f" fill="#8b94a3" '
                     'font-size="9" text-anchor="end">%.2g%s</text>' % (
                         pad_l - 4, y + 3, val, unit))
    for ts, vs, color, label in series:
        step = max(1, len(ts) // iw)
        pts = []
        for i in range(0, len(ts), step):
            x = pad_l + iw * ts[i] / t_max
            y = pad_t + ih * (1.0 - (vs[i] - ymin) / (ymax - ymin))
            pts.append("%.1f,%.1f" % (x, y))
        parts.append('<polyline fill="none" stroke="%s" '
                     'stroke-width="1.5" points="%s"/>' % (
                         color, " ".join(pts)))
    lx = pad_l + 6
    for _, _, color, label in series:
        parts.append('<text x="%d" y="%d" fill="%s" font-size="10">%s'
                     '</text>' % (lx, pad_t + 11, color, label))
        lx += 14 + 7 * len(label)
    parts.append('<text x="%d" y="%d" fill="#8b94a3" font-size="9" '
                 'text-anchor="end">0 s</text>' % (pad_l + 10,
                                                   height - 5))
    parts.append('<text x="%d" y="%d" fill="#8b94a3" font-size="9" '
                 'text-anchor="end">%.1f s</text>' % (width - pad_r,
                                                      height - 5, t_max))
    parts.append("</svg>")
    return "".join(parts)
CSS = """
body{background:#0d1117;color:#dbe2ec;font-family:system-ui,sans-serif;
margin:0;padding:24px}
h1{font-size:20px} h2{font-size:16px;margin:24px 0 8px}
.card{background:#161b24;border:1px solid #262d3a;border-radius:10px;
padding:16px;margin-bottom:20px}
.meters{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
.meter{background:#10151d;border:1px solid #262d3a;border-radius:8px;
padding:10px 14px;min-width:120px}
.meter .v{font-size:20px;font-weight:600}
.meter .l{font-size:11px;color:#8b94a3}
.ok{color:#5fd38a}.warn{color:#f0b45a}
.charts{display:flex;gap:14px;flex-wrap:wrap}
.note{color:#8b94a3;font-size:12px}
"""


def meter(label, value, cls=""):
    return ('<div class="meter"><div class="v %s">%s</div>'
            '<div class="l">%s</div></div>' % (cls, value, label))


def section(res, st):
    title = st["name"].replace("_", " ")
    if st["mono_upmix"]:
        title += " (mono source, dual-mono upmix)"
    pk_cls = "ok" if st["out_peak_db"] <= CEILING_DB + 0.01 else "warn"
    meters = "".join([
        meter("input peak", "%.2f dBFS" % st["in_peak_db"]),
        meter("output peak", "%.2f dBFS" % st["out_peak_db"], pk_cls),
        meter("input correlation", "%.3f" % st["in_corr"]),
        meter("output correlation", "%.3f" % st["out_corr"]),
        meter("max auto gain cut", "%.2f dB" % st["min_gain_db"]),
        meter("applied width", "%.2f - %.2f" % (st["width_min"],
                                                st["width_max"])),
    ])
    t = res["times"]
    ch_width = svg_chart(
        [(t, res["user_width"], "#f0b45a", "user width"),
         (t, res["applied_width"], "#5fb4f0", "applied width")],
        0.0, 2.2)
    ch_corr = svg_chart(
        [(t, res["correlation"], "#5fd38a", "L/R correlation")],
        -1.05, 1.05)
    ch_gain = svg_chart(
        [(t, res["gain_db"], "#e07ab8", "auto gain dB")],
        min(-12.0, min(res["gain_db"]) - 1.0), 1.0, unit=" dB")
    return (
        '<div class="card"><h2>%s</h2>'
        '<div class="meters">%s</div>'
        '<div class="charts">%s%s%s</div>'
        '<p class="note">ceiling %.1f dBFS | correlation threshold %.2f | '
        'output: %s</p></div>'
        % (title, meters, ch_width, ch_corr, ch_gain,
           CEILING_DB, CORR_THRESHOLD,
           os.path.basename(st["out_path"])))


def build_report(sections):
    body = "".join(sections)
    html = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Stereo Width Chain Report</title>"
        "<style>%s</style></head><body>"
        "<h1>Stereo Width Processing Chain - Report</h1>"
        "<p class='note'>Mid/Side width with correlation-aware limiting, "
        "smoothed automation and peak-safe auto gain. User automation: "
        "fast triangle sweep 0.2 - 2.0 (2 s period).</p>%s"
        "</body></html>" % (CSS, body))
    path = os.path.join(ART, "report.html")
    with open(path, "w") as f:
        f.write(html)
    return path


def main():
    sections = []
    print("%-14s %9s %9s %8s %8s %9s %s" % (
        "file", "in peak", "out peak", "in corr", "out corr",
        "gain min", "width"))
    for name in ("mono", "antiphase", "wide_music"):
        res, st = process_file(name)
        sections.append(section(res, st))
        print("%-14s %8.2f dB %8.2f dB %8.3f %8.3f %8.2f dB  %.2f-%.2f"
              % (name, st["in_peak_db"], st["out_peak_db"], st["in_corr"],
                 st["out_corr"], st["min_gain_db"], st["width_min"],
                 st["width_max"]))
    path = build_report(sections)
    print("report:", path)


if __name__ == "__main__":
    main()
