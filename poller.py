"""Polls the BYM API for every Map Room 2 world and keeps SQLite in sync.

Runs forever: every POLL_INTERVAL_SECONDS, fetches the world list, then for
each MR2 world fetches its snapshot (and terrain, once ever) and overwrites
the stored cell state, then fetches every MR2 alliance (one call, covers all
worlds) and overwrites that table too. No history is tracked — just the
current snapshot.

Auth is an API key (X-API-Key), not a player login — see config.py. Each of
terrain/snapshot/alliances is its own 10 req/min budget per key; at a
10-minute interval that's at most 2 requests per world per cycle (snapshot
always, terrain only until cached) plus one alliances call for the whole
poll, nowhere close to any of the three limits.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

import db
from config import BYM_BASE_URL, BYM_API_KEY, BYM_API_VERSION, POLL_INTERVAL_SECONDS

# db.replace_cells() deletes and re-inserts every occupied cell each poll,
# which churns the cells table's free pages (SQLite doesn't reclaim them on
# its own). A periodic VACUUM keeps the file size in check without doing it
# every cycle, which would pause writes for a few seconds each time.
VACUUM_INTERVAL_SECONDS = 24 * 60 * 60
_last_vacuum_at = 0.0


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def _fetch(path: str, query: str) -> tuple[bytes, dict[str, str]]:
    url = f"{BYM_BASE_URL}{path}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "X-API-Key": BYM_API_KEY,
            "Accept-Encoding": "gzip",
            # Cloudflare blocks urllib's default "Python-urllib/x.y" UA with a
            # 403 before the request reaches the app; any identifying UA works.
            "User-Agent": "bymr-mr2-poller/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        headers = {k.lower(): v for k, v in resp.getheaders()}
    if headers.get("content-encoding") == "gzip":
        raw = gzip.decompress(raw)
    return raw, headers


def fetch_worlds() -> list[dict]:
    raw, _ = _fetch(f"/api/{BYM_API_VERSION}/worlds", "")
    return json.loads(raw)["worlds"]


def fetch_terrain(world_uuid: str) -> bytes:
    raw, _ = _fetch("/worldmapv2/terrain", f"worldid={world_uuid}")
    return raw


def fetch_snapshot(world_uuid: str) -> dict:
    raw, _ = _fetch("/worldmapv2/snapshot", f"worldid={world_uuid}")
    return json.loads(raw)


def fetch_alliances() -> dict:
    """One call covers every MR2 alliance across every world — no worldid param."""
    raw, _ = _fetch("/worldmapv2/alliances", "")
    return json.loads(raw)


def alliances_to_rows(payload: dict) -> list[dict]:
    """Turns {"alliances": {"<id>": {world, name, members, relationships, ...}}} into db.py row dicts."""
    rows = []
    for alliance_id, a in payload.get("alliances", {}).items():
        rows.append({
            "alliance_id": int(alliance_id),
            "world_uuid": a["world"],
            "name": a["name"],
            "members": a.get("members", []),
            "relationships": a.get("relationships", {}),
        })
    return rows


def snapshot_to_cells(snapshot: dict) -> list[dict]:
    """Turns the snapshot's positional cell arrays into named dicts, with owner name resolved from the players sidecar."""
    players = snapshot.get("players", {})
    cells = []
    for row in snapshot.get("cells", []):
        x, y, base_type, uid, baseid, empirevalue, flinger, catapult, damage, protected, destroyed = row
        owner = players.get(str(uid)) if uid else None
        cells.append({
            "x": x, "y": y, "base_type": base_type, "uid": uid,
            "name": owner["name"] if owner else None,
            "avatar": owner.get("avatar") if owner else None,
            "baseid": baseid, "empirevalue": empirevalue, "flinger": flinger,
            "catapult": catapult, "damage": damage, "protected": protected, "destroyed": destroyed,
        })
    return cells


def poll_world(conn, world: dict) -> None:
    uuid = world["uuid"]

    if not db.has_terrain(conn, uuid):
        try:
            terrain_bytes = fetch_terrain(uuid)
            db.put_terrain(conn, uuid, terrain_bytes)
            conn.commit()
            log(f"  {world['name']}: terrain cached ({len(terrain_bytes)} bytes)")
        except urllib.error.HTTPError as e:
            log(f"  {world['name']}: terrain fetch failed ({e.code}) — will retry next cycle")

    try:
        snapshot = fetch_snapshot(uuid)
    except urllib.error.HTTPError as e:
        log(f"  {world['name']}: snapshot fetch failed ({e.code}) — skipping this cycle")
        return

    new_cells = snapshot_to_cells(snapshot)

    db.replace_cells(conn, uuid, new_cells)
    db.upsert_world(conn, uuid, world["name"], world["map_version"], world.get("playerCount", 0))
    # conn is one long-lived connection for the whole process; without an
    # explicit commit every write since startup sits in one open transaction,
    # invisible to server.py's separate read connections.
    conn.commit()

    log(f"  {world['name']}: {len(new_cells)} occupied cells")


def poll_once(conn) -> None:
    worlds = [w for w in fetch_worlds() if w["map_version"] == 2]
    log(f"Polling {len(worlds)} MR2 world(s)...")
    for world in worlds:
        try:
            poll_world(conn, world)
        except Exception:
            log(f"  {world.get('name', world.get('uuid'))}: unexpected error, skipping")
            traceback.print_exc()
            conn.rollback()  # discard this world's partial writes only

    try:
        rows = alliances_to_rows(fetch_alliances())
        db.replace_alliances(conn, rows)
        conn.commit()
        log(f"  Alliances: {len(rows)} across all MR2 worlds")
    except Exception:
        log("  Alliances: fetch failed, skipping this cycle")
        traceback.print_exc()
        conn.rollback()


def maybe_vacuum(conn: sqlite3.Connection) -> None:
    """Reclaims churned-up free pages (see VACUUM_INTERVAL_SECONDS). Runs at most once
    per interval, right after a successful poll cycle so it never competes with in-progress writes."""
    global _last_vacuum_at
    now = time.monotonic()
    if now - _last_vacuum_at < VACUUM_INTERVAL_SECONDS:
        return
    before = conn.execute("PRAGMA freelist_count").fetchone()[0]
    started = time.monotonic()
    conn.execute("VACUUM")
    _last_vacuum_at = now
    log(f"VACUUM done in {time.monotonic() - started:.1f}s (reclaimed {before} free pages)")


def main() -> None:
    if not BYM_API_KEY:
        raise SystemExit("BYM_API_KEY is not set — see .env.example")

    conn = db.connect()
    log(f"Poller starting. Interval: {POLL_INTERVAL_SECONDS}s. Target: {BYM_BASE_URL}")
    global _last_vacuum_at
    _last_vacuum_at = time.monotonic()  # skip VACUUM on the first cycle after a restart

    while True:
        started = time.monotonic()
        try:
            poll_once(conn)
            maybe_vacuum(conn)
        except Exception:
            log("Poll cycle failed:")
            traceback.print_exc()
            conn.rollback()

        elapsed = time.monotonic() - started
        sleep_for = max(0.0, POLL_INTERVAL_SECONDS - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
