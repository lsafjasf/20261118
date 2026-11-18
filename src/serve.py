"""Serve the artifacts directory over HTTP so the lightweight viewer can fetch
test_track.wav (browsers block fetch() of file:// URLs).

Usage: .venv/bin/python src/serve.py  ->  http://localhost:8000/viewer.html
"""

from __future__ import annotations

import http.server
import os
import socketserver

PORT = int(os.environ.get("PORT", "8000"))
DIRECTORY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "artifacts")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)


def main() -> None:
    os.chdir(DIRECTORY)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/viewer.html"
        print(f"serving {DIRECTORY}")
        print(f"open {url}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
