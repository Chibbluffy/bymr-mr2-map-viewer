"""Polls the BYM API for every Map Room 2 world and keeps SQLite in sync.

Runs forever: every POLL_INTERVAL_SECONDS, fetches the world list, then for
each MR2 world fetches its snapshot (and terrain, once ever) and diffs the
snapshot against the last poll's stored cells to produce world_events and
player_change_log rows before overwriting the stored state.

Auth is an API key (X-API-Key), not a player login — see config.py. Rate
limit is 10 req/min per endpoint per key, shared across every world; at a
10-minute interval that's a 100-request budget per cycle (2 requests per
world per cycle: snapshot always, terrain only until cached).
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
from db import WM, HOMECELL, OUTPOST

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


def diff_cells(world_uuid: str, old_by_pos: dict, new_cells: list[dict], batch_id: int) -> list[dict]:
    """Compares the previous poll's cells against this one and returns world_events rows to insert.

    old_by_pos is db.get_cells()'s return value; new_cells is
    snapshot_to_cells()'s output. A cell dropping out of the snapshot only
    logs RECYCLED if a player had owned it — a wild camp resetting isn't a
    player-driven event.
    """
    events = []
    new_by_pos = {(c["x"], c["y"]): c for c in new_cells}

    for pos, new in new_by_pos.items():
        old = old_by_pos.get(pos)

        if old is None:
            if new["uid"] > 0:
                events.append(_event(world_uuid, new, "CLAIMED_FROM_WILD", None, new, batch_id))
            continue

        if old["uid"] != new["uid"]:
            if old["uid"] == 0 and new["uid"] > 0:
                events.append(_event(world_uuid, new, "CLAIMED_FROM_WILD", old, new, batch_id))
            elif old["uid"] > 0 and new["uid"] > 0:
                events.append(_event(world_uuid, new, "TAKEOVER", old, new, batch_id))
            elif old["uid"] > 0 and new["uid"] == 0:
                events.append(_event(world_uuid, new, "RECYCLED", old, new, batch_id))
        # Damage-only changes aren't logged: there's no attacker identity in
        # this API surface, so it'd only ever say a cell took damage sometime
        # last cycle. `damage` is still stored on the cells table either way.

    for pos, old in old_by_pos.items():
        if pos not in new_by_pos and old["uid"] > 0:
            events.append(_event(world_uuid, old, "RECYCLED", old, None, batch_id))

    return events


def _event(world_uuid, pos_source, event_type, old, new, batch_id) -> dict:
    return {
        "world_uuid": world_uuid,
        "x": pos_source["x"], "y": pos_source["y"],
        "base_type": (new or old)["base_type"] if (new or old) else None,
        "event_type": event_type,
        "old_uid": old["uid"] if old else None,
        "old_name": old["name"] if old else None,
        "new_uid": new["uid"] if new else None,
        "new_name": new["name"] if new else None,
        "old_damage": old["damage"] if old else None,
        "new_damage": new["damage"] if new else None,
        "batch_id": batch_id,
    }


def update_player_changes(conn, world_uuid: str, cells: list[dict]) -> None:
    """Logs one row per player whose total empire value (home + every outpost) or outpost count
    changed since their last recorded value. Sparse by design.

    Sums across every owned cell rather than just the home cell's own value,
    so a player with a modest home but valuable outposts isn't shown near
    zero. Feeds both leaderboards and the inactivity signal in db.py.
    """
    outposts_by_uid: dict[int, int] = {}
    total_ev_by_uid: dict[int, int] = {}
    homes_by_uid: dict[int, dict] = {}

    for c in cells:
        if c["uid"] <= 0:
            continue
        total_ev_by_uid[c["uid"]] = total_ev_by_uid.get(c["uid"], 0) + (c["empirevalue"] or 0)
        if c["base_type"] == OUTPOST:
            outposts_by_uid[c["uid"]] = outposts_by_uid.get(c["uid"], 0) + 1
        elif c["base_type"] == HOMECELL:
            homes_by_uid[c["uid"]] = c

    for uid, home in homes_by_uid.items():
        empirevalue = total_ev_by_uid.get(uid, 0)
        outpost_count = outposts_by_uid.get(uid, 0)

        last = db.last_player_stat(conn, world_uuid, uid)
        if last is not None and last["empirevalue"] == empirevalue and last["outpost_count"] == outpost_count:
            continue

        delta_ev = empirevalue - last["empirevalue"] if last else 0
        delta_op = outpost_count - last["outpost_count"] if last else 0
        db.insert_player_change(conn, world_uuid, uid, home["name"], empirevalue, outpost_count, delta_ev, delta_op)


def poll_world(conn, world: dict, batch_id: int) -> None:
    uuid = world["uuid"]
    # A world with no `worlds` row yet has no cells baseline either (both
    # written together at the end of a successful poll) — without this check
    # its first poll would diff against an empty old_by_pos and log every
    # occupied cell as freshly CLAIMED_FROM_WILD.
    is_first_poll = db.get_world(conn, uuid) is None

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
    old_by_pos = db.get_cells(conn, uuid)

    events = [] if is_first_poll else diff_cells(uuid, old_by_pos, new_cells, batch_id)
    for ev in events:
        db.insert_event(conn, **ev)

    update_player_changes(conn, uuid, new_cells)
    db.replace_cells(conn, uuid, new_cells)
    db.upsert_world(conn, uuid, world["name"], world["map_version"], world.get("playerCount", 0))
    # conn is one long-lived connection for the whole process; without an
    # explicit commit every write since startup sits in one open transaction,
    # invisible to server.py's separate read connections.
    conn.commit()

    suffix = " (baseline seed, no events)" if is_first_poll else f", {len(events)} events"
    log(f"  {world['name']}: {len(new_cells)} occupied cells{suffix}")


def poll_once(conn) -> None:
    worlds = [w for w in fetch_worlds() if w["map_version"] == 2]
    log(f"Polling {len(worlds)} MR2 world(s)...")
    # One id shared by every event this cycle produces, across all worlds, so
    # list_events_grouped() can collapse a burst into one feed row. Safe to
    # share across worlds since every grouping query also filters by
    # world_uuid. int(time.time()) is unique enough at a 10-minute cadence.
    batch_id = int(time.time())
    for world in worlds:
        try:
            poll_world(conn, world, batch_id)
        except Exception:
            log(f"  {world.get('name', world.get('uuid'))}: unexpected error, skipping")
            traceback.print_exc()
            conn.rollback()  # discard this world's partial writes only


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
