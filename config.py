"""Shared config for poller.py and server.py.

Reads real environment variables first (e.g. set by systemd/a process
manager), then falls back to a local .env file if one exists — a small
hand-rolled loader, not a dependency, so a real env var always wins over
whatever .env has for the same name.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent / ".env"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(ENV_FILE)

# The BYM server this poller/server talks to for its own API calls. Same
# default as the browser viewer's "Stable" server selection.
BYM_BASE_URL = os.environ.get("BYM_BASE_URL", "https://server.bymrefitted.com").rstrip("/")
BYM_API_VERSION = os.environ.get("BYM_API_VERSION", "v1.6.2-beta")

# Required — get one from the BYM dev per the #api-consumers announcement.
# Never sent to the browser; only poller.py uses it, server-to-server.
BYM_API_KEY = os.environ.get("BYM_API_KEY", "")

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "600"))

# server.py — mirrors dev_server.py's existing env vars.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8081"))
STATIC_DIR = os.environ.get("STATIC_DIR", str(Path(__file__).resolve().parent / "app" / "static"))
