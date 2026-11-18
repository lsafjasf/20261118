"""标准库 HTTP 服务：静态页面 + 同步分析/微调/验证/导出 API。"""

from __future__ import annotations

import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .engine import SyncEngine
from .report import build_report, write_csv_matrix, write_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")
MEDIA_DIR = os.path.join(ROOT, "samples", "media")
OUT_DIR = os.path.join(ROOT, "samples", "output")


class ApiState:
    """持有引擎与当前微调，模拟一次工作站会话。"""

    def __init__(self) -> None:
        self.engine = SyncEngine(MEDIA_DIR)
        self.engine.analyze()

    def report(self) -> dict:
        return build_report(self.engine)


STATE = ApiState()


class Handler(BaseHTTPRequestHandler):
    server_version = "SlateSync/1.0"

    def log_message(self, *_args) -> None:
        return

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            self._send_json(self._state_payload())
            return
        if path.startswith("/media/"):
            self._serve_file(os.path.join(MEDIA_DIR, os.path.basename(path)))
            return
        if path == "/api/export":
            self._handle_export()
            return
        self._serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/nudge":
                body = self._read_json()
                STATE.engine.set_nudge(str(body["trackId"]), float(body["nudgeMs"]))
                self._send_json(self._state_payload())
            elif path == "/api/reset":
                body = self._read_json()
                STATE.engine.set_nudge(str(body["trackId"]), 0.0)
                self._send_json(self._state_payload())
            elif path == "/api/reanalyze":
                STATE.engine = SyncEngine(MEDIA_DIR)
                STATE.engine.analyze()
                self._send_json(self._state_payload())
            else:
                self._send_json({"error": "not found"}, 404)
        except (ValueError, KeyError) as exc:
            self._send_json({"error": str(exc)}, 400)

    def _handle_export(self) -> None:
        os.makedirs(OUT_DIR, exist_ok=True)
        full_report = STATE.report()
        json_path = os.path.join(OUT_DIR, "sync-report.json")
        csv_path = os.path.join(OUT_DIR, "sync-matrix.csv")
        write_json(full_report, json_path)
        write_csv_matrix(full_report, csv_path)
        self._send_json({"ok": True,
                         "json": os.path.relpath(json_path, ROOT),
                         "csv": os.path.relpath(csv_path, ROOT),
                         "tracks": len(full_report["matrix"])})

    def _state_payload(self) -> dict:
        full_report = STATE.report()
        return {
            "project": full_report["project"],
            "masterTrackId": full_report["masterTrackId"],
            "commonInSec": full_report["commonInSec"],
            "commonOutSec": full_report["commonOutSec"],
            "commonDurationSec": full_report["commonDurationSec"],
            "programCuts": full_report["programCuts"],
            "programSegments": full_report["programSegments"],
            "matrix": full_report["matrix"],
            "verification": full_report["verification"],
            "tracks": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "role": item["role"],
                    "kind": item["kind"],
                    "duration": item["duration"],
                    "audioPath": item["audioPath"],
                    "videoPath": item["videoPath"],
                    "onsets": item["analysis"]["onsetEvents"],
                    "slateLocalSec": item["analysis"]["slateLocalSec"],
                }
                for item in full_report["tracks"]
            ],
        }

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        self._serve_file(os.path.join(WEB_DIR, relative))

    def _serve_file(self, absolute: str) -> None:
        if not os.path.isfile(absolute):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(absolute)[0] or "application/octet-stream"
        with open(absolute, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(port: int = 8067) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"SLATE/SYNC 工作站: http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
