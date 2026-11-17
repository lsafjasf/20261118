"""Local web UI for the keyframe browser.

Clicking a keyframe row loads its thumbnail; a form accepts a target
time and performs precise decode from the nearest preceding keyframe.

Usage: python3 -m kfbrowser.server <video> [port]
"""
from __future__ import annotations

import html
import os
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .mp4index import build_index
from .seeker import extract_thumbnail, precise_seek

_INDEX = None
_TMPDIR = tempfile.mkdtemp(prefix="kfbrowser_")

PAGE = """<!doctype html><html><head><meta charset=utf-8>
<title>keyframe browser</title><style>
body{{font-family:monospace;margin:2em}}table{{border-collapse:collapse}}
td,th{{border:1px solid #999;padding:2px 8px}}tr:hover{{background:#eef}}
img{{margin-top:1em;border:1px solid #333}}
.miss{{color:#b00}}.hit{{color:#070}}
</style></head><body>
<h2>Keyframe browser: {name}</h2>
<p>duration {dur:.3f}s | samples {samples} | keyframes {nkf} |
estimated GOP interval {gop} | edit-list media offset {eloff:.3f}s</p>
<form method=get action=/seek>target time (s):
<input name=t value="1.0"><input type=submit value="decode to target">
</form>
<table><tr><th>#</th><th>frame</th><th>time (s)</th>
<th>file offset</th><th>size</th></tr>
{rows}</table>{extra}</body></html>"""


def _row(i, kf):
    return (f'<tr><td><a href="/thumb?k={i}">{i}</a></td>'
            f"<td>{kf.frame_number}</td><td>{kf.pts_seconds:.3f}</td>"
            f"<td>{kf.file_offset}</td><td>{kf.size}</td></tr>")


def _page(extra=""):
    idx = _INDEX
    gop = idx.gop_interval
    return PAGE.format(
        name=html.escape(os.path.basename(idx.path)),
        dur=idx.duration_seconds, samples=idx.sample_count,
        nkf=len(idx.keyframes),
        gop=f"{gop:.3f}s" if gop is not None else "n/a",
        eloff=idx.media_time_offset,
        rows="".join(_row(i, k) for i, k in enumerate(idx.keyframes)),
        extra=extra,
    )
class Handler(BaseHTTPRequestHandler):
    def _send(self, body, ctype="text/html; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if url.path == "/":
            self._send(_page())
        elif url.path == "/thumb":
            self._thumb(int(qs["k"][0]))
        elif url.path == "/img":
            self._img(int(qs["k"][0]))
        elif url.path == "/seek":
            self._seek(float(qs["t"][0]))
        else:
            self.send_error(404)

    def _thumb(self, k):
        kf = _INDEX.keyframes[k]
        out = os.path.join(_TMPDIR, f"kf{k}.jpg")
        if not os.path.exists(out):
            extract_thumbnail(_INDEX, kf, out)
        extra = (f"<p>keyframe {k}: frame {kf.frame_number}, "
                 f"{kf.pts_seconds:.3f}s, offset {kf.file_offset}</p>"
                 f'<img src="/img?k={k}">')
        self._send(_page(extra))

    def _img(self, k):
        out = os.path.join(_TMPDIR, f"kf{k}.jpg")
        if not os.path.exists(out):
            extract_thumbnail(_INDEX, _INDEX.keyframes[k], out)
        with open(out, "rb") as f:
            self._send(f.read(), "image/jpeg")

    def _seek(self, t):
        r = precise_seek(_INDEX, t)
        if r.ok:
            kf = r.lookup.keyframe
            extra = (f'<p class=hit>HIT t={t}: keyframe '
                     f"frame={kf.frame_number} pts={kf.pts_seconds:.3f}s "
                     f"offset={kf.file_offset}; decoded "
                     f"{r.frames_decoded} frames to frame "
                     f"{r.target_frame}; hash match={r.hash_match}</p>")
        else:
            extra = f'<p class=miss>MISS t={t}: {html.escape(r.reason)}</p>'
        self._send(_page(extra))

    def log_message(self, *a):
        pass


def main(argv):
    global _INDEX
    _INDEX = build_index(argv[1])
    port = int(argv[2]) if len(argv) > 2 else 8377
    print(f"serving {argv[1]} on http://127.0.0.1:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    import sys
    main(sys.argv)
