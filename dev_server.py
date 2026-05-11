from __future__ import annotations

import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
STATIC_DIR = Path(os.environ.get("STATIC_DIR", REPO_ROOT / "app" / "static")).resolve()
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8081"))


class StaticViewerHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def main() -> None:
    if not STATIC_DIR.exists():
        raise SystemExit(f"Static directory does not exist: {STATIC_DIR}")

    handler = partial(StaticViewerHandler, directory=str(STATIC_DIR))
    server = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Serving BYM MR2 Viewer at http://{HOST}:{PORT}")
    print(f"Static root: {STATIC_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
