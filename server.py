"""Serves the viewer's static files, plus a small read-only JSON API backed by the SQLite
database poller.py keeps populated. Replaces dev_server.py in production.

Nothing here ever calls the real BYM API or touches BYM_API_KEY — that's
poller.py's job. Static files and the API share one process, so requests
are same-origin and there's no CORS to configure.
"""

from __future__ import annotations

import json
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import db
from config import HOST, PORT, STATIC_DIR

PERIOD_SECONDS = {"day": 86400, "week": 7 * 86400, "month": 30 * 86400}

# The export page reuses index.html; app.js detects the URL at runtime and
# reveals its export-specific UI. Relative asset requests still resolve
# against /tnb/export/, only the HTML bytes served are swapped.
EXPORT_URL_PATHS = {"/tnb/export", "/tnb/export/", "/tnb/export/index.html"}


class ViewerHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def translate_path(self, path: str) -> str:
        if urlsplit(path).path in EXPORT_URL_PATHS:
            return str(Path(self.directory) / "index.html")
        return super().translate_path(path)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self._handle_api(path)
            return
        super().do_GET()

    # ─── API routing ────────────────────────────────────────────────────────

    def _handle_api(self, path: str) -> None:
        query = parse_qs(urlsplit(self.path).query)
        world = (query.get("world") or [None])[0]

        try:
            if path == "/api/worlds":
                self._json(self._route_worlds())
            elif path == "/api/terrain":
                self._route_terrain(world)
            elif path == "/api/snapshot":
                self._json(self._route_snapshot(world))
            elif path == "/api/leaderboard/activity":
                self._json(self._route_activity_leaderboard(world))
            elif path == "/api/leaderboard/empire":
                self._json(self._route_empire_leaderboard(world))
            elif path == "/api/events":
                event_type = (query.get("type") or [None])[0]
                player = (query.get("player") or [None])[0]
                before_id_raw = (query.get("before_id") or [None])[0]
                before_id = int(before_id_raw) if before_id_raw else None
                limit = int((query.get("limit") or ["20"])[0])
                self._json(self._route_events(world, event_type, player, before_id, limit))
            elif path == "/api/inactive":
                days = int((query.get("days") or ["7"])[0])
                self._json(self._route_inactive(world, days))
            elif path == "/api/locate":
                name = (query.get("name") or [None])[0]
                self._json(self._route_locate(name))
            elif path == "/api/locate/suggest":
                term = (query.get("term") or [None])[0]
                limit = int((query.get("limit") or ["8"])[0])
                self._json(self._route_locate_suggest(term, limit))
            else:
                self._json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except ApiError as e:
            self._json({"error": e.message}, status=e.status)
        except Exception as e:
            self._json({"error": "Internal error"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            print(f"API error on {path}: {e!r}")

    # ─── Routes ─────────────────────────────────────────────────────────────

    def _route_worlds(self) -> list[dict]:
        with db.session() as conn:
            return [dict(row) for row in db.list_worlds(conn)]

    def _route_terrain(self, world: str | None) -> None:
        world = _require_world(world)
        with db.session() as conn:
            raw = db.get_terrain(conn, world)
        if raw is None:
            self._json({"error": "Terrain not yet cached for this world"}, status=HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _route_snapshot(self, world: str | None) -> dict:
        world = _require_world(world)
        with db.session() as conn:
            world_row = db.get_world(conn, world)
            cell_rows = db.get_cells(conn, world).values()

        if world_row is None:
            raise ApiError("Unknown world", HTTPStatus.NOT_FOUND)

        players: dict[str, dict] = {}
        cells = []
        for c in cell_rows:
            if c["uid"] and str(c["uid"]) not in players:
                players[str(c["uid"])] = {"name": c["name"], "avatar": c["avatar"]}
            cells.append([
                c["x"], c["y"], c["base_type"], c["uid"], c["baseid"],
                c["empirevalue"], c["flinger"], c["catapult"], c["damage"], c["protected"], c["destroyed"],
            ])

        return {
            "worldid": world,
            "generatedAt": world_row["last_polled_at"],
            "players": players,
            "cells": cells,
        }

    def _period_cutoffs(self) -> tuple[int, int, int]:
        now = db.now()
        return now - PERIOD_SECONDS["day"], now - PERIOD_SECONDS["week"], now - PERIOD_SECONDS["month"]

    def _route_activity_leaderboard(self, world: str | None) -> list[dict]:
        world = _require_world(world)
        day, week, month = self._period_cutoffs()
        with db.session() as conn:
            return db.activity_leaderboard(conn, world, day, week, month)

    def _route_empire_leaderboard(self, world: str | None) -> list[dict]:
        world = _require_world(world)
        day, week, month = self._period_cutoffs()
        with db.session() as conn:
            return db.empire_leaderboard(conn, world, day, week, month)

    def _route_events(self, world: str | None, event_type: str | None, player: str | None,
                       before_id: int | None, limit: int) -> dict:
        world = _require_world(world)
        with db.session() as conn:
            groups, next_before_id = db.list_events_grouped(conn, world, event_type, player, before_id, limit)
        return {"groups": groups, "next_before_id": next_before_id}

    def _route_inactive(self, world: str | None, days: int) -> list[dict]:
        world = _require_world(world)
        before = db.now() - days * 86400
        with db.session() as conn:
            return [dict(row) for row in db.inactive_players(conn, world, before)]

    def _route_locate(self, name: str | None) -> list[dict]:
        """World-independent: which currently-polled world(s) a player's home base is in right now."""
        if not name:
            raise ApiError("Missing name query param", HTTPStatus.BAD_REQUEST)
        with db.session() as conn:
            return [dict(row) for row in db.find_player_home(conn, name)]

    def _route_locate_suggest(self, term: str | None, limit: int) -> list[dict]:
        """As-you-type suggestions backing Locate's dropdown. See db.search_players()."""
        if not term:
            raise ApiError("Missing term query param", HTTPStatus.BAD_REQUEST)
        with db.session() as conn:
            return [dict(row) for row in db.search_players(conn, term, limit)]

    # ─── Response helper ────────────────────────────────────────────────────

    def _json(self, payload, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ApiError(Exception):
    def __init__(self, message: str, status: HTTPStatus):
        super().__init__(message)
        self.message = message
        self.status = status


def _require_world(world: str | None) -> str:
    if not world:
        raise ApiError("Missing world query param", HTTPStatus.BAD_REQUEST)
    return world


def main() -> None:
    handler = partial(ViewerHandler, directory=STATIC_DIR)
    server = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Serving BYM MR2 Viewer at http://{HOST}:{PORT}")
    print(f"Static root: {STATIC_DIR}")
    print(f"Database: {db.DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
