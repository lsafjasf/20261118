"""Static file server rooted at the project directory (stdlib only)."""

import argparse
import functools
import http.server
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap.add_argument("--root", default=root)
    args = ap.parse_args()
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=args.root
    )
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        actual_port = httpd.server_address[1]
        url = f"http://127.0.0.1:{actual_port}/web/index.html"
        print(f"serving {args.root} at {url}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
