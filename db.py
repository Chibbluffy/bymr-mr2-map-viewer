"""SQLite storage for polled MR2 world data.

- `worlds` / `terrain` / `cells` — latest known state, overwritten each poll.
- `world_events` — append-only, one row per cell whose ownership changed
  between two polls (TAKEOVER / CLAIMED_FROM_WILD / RECYCLED). Damage-only
  changes aren't logged: there's no attacker identity in this API, so it'd
  only ever say "something happened". See poller.diff_cells().
- `player_change_log` — append-only, one row per poll where a player's home
  empire value or outpost count actually changed. Source for both the
  activity leaderboard (SUM deltas over a period) and the inactivity signal
  (no rows recently == no activity recently; there's no server-side
  last-login field).
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "mr2.sqlite3"

# Matches the game server's MapRoomCell enum (server/src/enums/MapRoom.ts in
# backyard-monsters-refitted).
WM = 1
HOMECELL = 2
OUTPOST = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
  uuid           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  map_version    INTEGER NOT NULL,
  player_count   INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER
);

CREATE TABLE IF NOT EXISTS terrain (
  world_uuid TEXT PRIMARY KEY,
  bytes      BLOB NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Latest known state of every occupied cell, one row per (world, x, y).
-- Overwritten each poll; diffed against prior contents to produce
-- world_events rows first.
CREATE TABLE IF NOT EXISTS cells (
  world_uuid  TEXT NOT NULL,
  x           INTEGER NOT NULL,
  y           INTEGER NOT NULL,
  base_type   INTEGER NOT NULL,
  uid         INTEGER NOT NULL,
  name        TEXT,
  avatar      TEXT,
  baseid      TEXT,
  empirevalue INTEGER NOT NULL DEFAULT 0,
  flinger     INTEGER NOT NULL DEFAULT 0,
  catapult    INTEGER NOT NULL DEFAULT 0,
  damage      INTEGER NOT NULL DEFAULT 0,
  protected   INTEGER NOT NULL DEFAULT 0,
  destroyed   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (world_uuid, x, y)
);
CREATE INDEX IF NOT EXISTS idx_cells_world_uid ON cells(world_uuid, uid);

-- event_type: TAKEOVER | CLAIMED_FROM_WILD | RECYCLED | RELOCATED | JOINED | RENAMED
--             | KIT_BUILT | KIT_UPGRADED
-- RELOCATED (a player moving their home base to a former outpost, once/day
-- server-side) is the only type that uses old_x/old_y: x/y is the new home
-- location, old_x/old_y is where it moved from. Every other type only ever
-- has one location, so old_x/old_y stay NULL for them.
-- old_tier/new_tier are only for KIT_BUILT/KIT_UPGRADED — see poller.py's
-- _classify_outpost_kit_tier() for what they mean and how they were derived.
-- batch_id: shared by every event from one poll_once() cycle (set in
-- poller.py), so list_events_grouped() can collapse a burst into one row.
CREATE TABLE IF NOT EXISTS world_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  world_uuid   TEXT NOT NULL,
  x            INTEGER NOT NULL,
  y            INTEGER NOT NULL,
  base_type    INTEGER,
  event_type   TEXT NOT NULL,
  old_uid      INTEGER,
  old_name     TEXT,
  new_uid      INTEGER,
  new_name     TEXT,
  old_damage   INTEGER,
  new_damage   INTEGER,
  detected_at  INTEGER NOT NULL,
  batch_id     INTEGER,
  old_x        INTEGER,
  old_y        INTEGER,
  old_tier     TEXT,
  new_tier     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_world_time ON world_events(world_uuid, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_world_type_time ON world_events(world_uuid, event_type, detected_at DESC);

-- empirevalue/delta_empirevalue is the player's TOTAL value summed across
-- every cell they own (home + outposts), computed in poller.py's
-- update_player_changes().
CREATE TABLE IF NOT EXISTS player_change_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  world_uuid       TEXT NOT NULL,
  uid              INTEGER NOT NULL,
  name             TEXT,
  polled_at        INTEGER NOT NULL,
  empirevalue      INTEGER NOT NULL,
  outpost_count    INTEGER NOT NULL,
  delta_empirevalue INTEGER NOT NULL,
  delta_outposts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_world_uid_time ON player_change_log(world_uuid, uid, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_log_world_time ON player_change_log(world_uuid, polled_at DESC);
"""

# Column additions to an existing DB that CREATE TABLE IF NOT EXISTS can't
# express. Each entry: (table, column, ddl), applied only if the column is
# missing (no-op on a fresh DB, which gets it from SCHEMA directly).
_MIGRATIONS = [
    ("world_events", "batch_id", "ALTER TABLE world_events ADD COLUMN batch_id INTEGER"),
    ("world_events", "old_x", "ALTER TABLE world_events ADD COLUMN old_x INTEGER"),
    ("world_events", "old_y", "ALTER TABLE world_events ADD COLUMN old_y INTEGER"),
    ("world_events", "old_tier", "ALTER TABLE world_events ADD COLUMN old_tier TEXT"),
    ("world_events", "new_tier", "ALTER TABLE world_events ADD COLUMN new_tier TEXT"),
]


def _run_migrations(conn: sqlite3.Connection) -> None:
    for table, column, ddl in _MIGRATIONS:
        cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(ddl)
            conn.commit()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    _run_migrations(conn)
    return conn


@contextmanager
def session():
    """Connection that actually closes on exit (sqlite3's own context manager only commits/rolls back)."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def now() -> int:
    return int(time.time())


# ─── Worlds ────────────────────────────────────────────────────────────────

def upsert_world(conn: sqlite3.Connection, uuid: str, name: str, map_version: int, player_count: int) -> None:
    conn.execute(
        """
        INSERT INTO worlds (uuid, name, map_version, player_count, last_polled_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          name = excluded.name,
          map_version = excluded.map_version,
          player_count = excluded.player_count,
          last_polled_at = excluded.last_polled_at
        """,
        (uuid, name, map_version, player_count, now()),
    )


def list_worlds(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM worlds WHERE map_version = 2 ORDER BY name").fetchall()


def get_world(conn: sqlite3.Connection, uuid: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM worlds WHERE uuid = ?", (uuid,)).fetchone()


# ─── Terrain ───────────────────────────────────────────────────────────────

def has_terrain(conn: sqlite3.Connection, world_uuid: str) -> bool:
    row = conn.execute("SELECT 1 FROM terrain WHERE world_uuid = ?", (world_uuid,)).fetchone()
    return row is not None


def put_terrain(conn: sqlite3.Connection, world_uuid: str, raw_bytes: bytes) -> None:
    conn.execute(
        """
        INSERT INTO terrain (world_uuid, bytes, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(world_uuid) DO UPDATE SET bytes = excluded.bytes, fetched_at = excluded.fetched_at
        """,
        (world_uuid, raw_bytes, now()),
    )


def get_terrain(conn: sqlite3.Connection, world_uuid: str) -> bytes | None:
    row = conn.execute("SELECT bytes FROM terrain WHERE world_uuid = ?", (world_uuid,)).fetchone()
    return row["bytes"] if row else None


# ─── Cells ─────────────────────────────────────────────────────────────────

def get_cells(conn: sqlite3.Connection, world_uuid: str) -> dict[tuple[int, int], sqlite3.Row]:
    """Current cell state for a world, keyed by (x, y)."""
    rows = conn.execute("SELECT * FROM cells WHERE world_uuid = ?", (world_uuid,)).fetchall()
    return {(row["x"], row["y"]): row for row in rows}


def find_player_home(conn: sqlite3.Connection, name: str) -> list[sqlite3.Row]:
    """Every currently-polled world where `name` has a home base right now (exact match).

    Usually zero or one row (usernames are globally unique, one active home
    per account). `cells` is fully replaced each poll, so a relocated/
    recycled player's old row disappears as soon as that world re-polls.
    Briefly more than one row is possible mid-relocation across worlds with
    different poll timing — callers should treat that as still settling.
    """
    return conn.execute(
        """
        SELECT c.world_uuid, w.name AS world_name, c.x, c.y, c.empirevalue, c.updated_at
        FROM cells c
        JOIN worlds w ON w.uuid = c.world_uuid
        WHERE c.base_type = ? AND c.name = ? COLLATE NOCASE AND w.map_version = 2
        ORDER BY c.updated_at DESC
        """,
        (HOMECELL, name),
    ).fetchall()


def search_players(conn: sqlite3.Connection, term: str, limit: int = 8) -> list[sqlite3.Row]:
    """Substring, case-insensitive home-base name search across every polled world. Powers Locate's live suggestions."""
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return conn.execute(
        """
        SELECT c.world_uuid, w.name AS world_name, c.x, c.y, c.name, c.empirevalue, c.updated_at
        FROM cells c
        JOIN worlds w ON w.uuid = c.world_uuid
        WHERE c.base_type = ? AND c.name LIKE ? ESCAPE '\\' AND w.map_version = 2
        ORDER BY c.name COLLATE NOCASE
        LIMIT ?
        """,
        (HOMECELL, like, limit),
    ).fetchall()


def replace_cells(conn: sqlite3.Connection, world_uuid: str, cells: list[dict]) -> None:
    """Overwrites every cell row for a world with the freshly polled set."""
    ts = now()
    conn.execute("DELETE FROM cells WHERE world_uuid = ?", (world_uuid,))
    conn.executemany(
        """
        INSERT INTO cells (world_uuid, x, y, base_type, uid, name, avatar, baseid,
                            empirevalue, flinger, catapult, damage, protected, destroyed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                world_uuid, c["x"], c["y"], c["base_type"], c["uid"], c.get("name"), c.get("avatar"), c.get("baseid"),
                c["empirevalue"], c["flinger"], c["catapult"], c["damage"], c["protected"], c["destroyed"], ts,
            )
            for c in cells
        ],
    )


# ─── Events ────────────────────────────────────────────────────────────────

def insert_event(conn: sqlite3.Connection, world_uuid: str, x: int, y: int, base_type: int | None,
                  event_type: str, old_uid: int | None, old_name: str | None,
                  new_uid: int | None, new_name: str | None,
                  old_damage: int | None, new_damage: int | None, batch_id: int | None = None,
                  old_x: int | None = None, old_y: int | None = None,
                  old_tier: str | None = None, new_tier: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO world_events (world_uuid, x, y, base_type, event_type, old_uid, old_name,
                                   new_uid, new_name, old_damage, new_damage, detected_at, batch_id,
                                   old_x, old_y, old_tier, new_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (world_uuid, x, y, base_type, event_type, old_uid, old_name, new_uid, new_name,
         old_damage, new_damage, now(), batch_id, old_x, old_y, old_tier, new_tier),
    )


def list_events(conn: sqlite3.Connection, world_uuid: str | None, event_type: str | None = None,
                 player: str | None = None, before_id: int | None = None, limit: int = 50) -> list[sqlite3.Row]:
    """`world_uuid` is None for "every polled world at once" (the Events feed's all-worlds toggle);
    each row then carries `world_name` too, from the join, so the caller can label it.

    `player` matches either side (old_name or new_name), substring case-insensitive.
    `before_id` continues a previous page by id rather than OFFSET, so
    pagination stays correct even as new events keep inserting at the front.
    """
    where = ["w.map_version = 2"]
    params: list = []

    if world_uuid:
        where.append("e.world_uuid = ?")
        params.append(world_uuid)
    if event_type:
        where.append("e.event_type = ?")
        params.append(event_type)
    if player:
        where.append("(e.old_name LIKE ? ESCAPE '\\' OR e.new_name LIKE ? ESCAPE '\\')")
        like = "%" + player.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        params.extend([like, like])
    if before_id is not None:
        where.append("e.id < ?")
        params.append(before_id)

    params.append(limit)
    return conn.execute(
        f"""
        SELECT e.*, w.name AS world_name
        FROM world_events e
        JOIN worlds w ON w.uuid = e.world_uuid
        WHERE {' AND '.join(where)}
        ORDER BY e.detected_at DESC, e.id DESC LIMIT ?
        """,
        params,
    ).fetchall()


# Raw rows fetched per group requested, to have enough material to fill a
# page of groups in one round trip (see list_events_grouped()).
_GROUP_OVERFETCH_FACTOR = 8

# Safety cap on how many extra fetch rounds list_events_grouped() will do to
# finish absorbing one oversized group (e.g. a mass-recycle of thousands of
# outposts in one poll cycle) rather than splitting it across pages.
_GROUP_MAX_FETCH_ROUNDS = 50

# Grouping granularity by event age: coarser the older an event is, so a
# burst of same-matchup events collapses into one row whether it happened
# within one poll cycle or was spread across a few.
_BUCKET_RECENT_SECONDS = 3600      # under 1h old -> 10-minute buckets
_BUCKET_RECENT_SIZE = 600
_BUCKET_DAY_SECONDS = 86400        # under 1d old -> hourly buckets
_BUCKET_DAY_SIZE = 3600
_BUCKET_DEFAULT_SIZE = 86400       # older -> daily buckets


def _event_time_bucket(now: int, detected_at: int) -> int:
    age = now - detected_at
    if age < _BUCKET_RECENT_SECONDS:
        size = _BUCKET_RECENT_SIZE
    elif age < _BUCKET_DAY_SECONDS:
        size = _BUCKET_DAY_SIZE
    else:
        size = _BUCKET_DEFAULT_SIZE
    return detected_at // size


def list_events_grouped(conn: sqlite3.Connection, world_uuid: str | None, event_type: str | None = None,
                         player: str | None = None, before_id: int | None = None,
                         limit: int = 20) -> tuple[list[dict], int | None]:
    """Same filters/pagination as list_events(), collapsed by (world, time bucket, event_type, old_uid,
    new_uid, base_type) — "Player A took 5 outposts from Player B" instead of 5 rows. world_uuid is part
    of the key (even though it's usually already fixed by the `world_uuid` filter) purely so an all-worlds
    fetch never accidentally merges two different worlds' events; base_type is part of the key so a home
    base is never merged into the same group as outposts (they read very differently: losing your one
    home base vs. losing some outposts). Bucket size depends on event age (see _event_time_bucket()), so
    a burst collapses together even if it spans a few poll cycles.

    Always fetches until a group boundary is confirmed rather than stopping at a fixed raw-row
    count, so one oversized group (e.g. a mass-recycle of thousands of outposts in one poll cycle)
    is never split across pages into several identical-looking "recycled N outposts" rows.

    Returns (groups, next_before_id); next_before_id is a raw event id, so
    passing it back as before_id resumes exactly where the underlying rows
    left off regardless of how many groups they collapsed into. None once
    there's nothing further to fetch.
    """
    fetch_size = limit * _GROUP_OVERFETCH_FACTOR
    current_time = now()

    groups: dict[tuple, dict] = {}
    order: list[tuple] = []
    cursor = before_id
    exhausted = False

    for _ in range(_GROUP_MAX_FETCH_ROUNDS):
        raw = list_events(conn, world_uuid, event_type, player, cursor, limit=fetch_size)
        if not raw:
            exhausted = True
            break

        for row in raw:
            # CLAIMED_FROM_WILD's old_uid is None (no prior baseline) or 0
            # (already known wild) — same meaning, normalize to 0 for grouping.
            group_old_uid = row["old_uid"] or 0 if row["event_type"] == "CLAIMED_FROM_WILD" else row["old_uid"]
            bucket = _event_time_bucket(current_time, row["detected_at"])
            key = (row["world_uuid"], bucket, row["event_type"], group_old_uid, row["new_uid"], row["base_type"])
            g = groups.get(key)
            if g is None:
                g = {
                    "world_uuid": row["world_uuid"], "world_name": row["world_name"],
                    "event_type": row["event_type"],
                    "old_uid": row["old_uid"], "old_name": row["old_name"],
                    "new_uid": row["new_uid"], "new_name": row["new_name"],
                    "base_type": row["base_type"], "detected_at": row["detected_at"],
                    "old_x": row["old_x"], "old_y": row["old_y"],
                    "old_tier": row["old_tier"], "new_tier": row["new_tier"],
                    "count": 0, "cells": [],
                }
                groups[key] = g
                order.append(key)
            g["count"] += 1
            # old_tier/new_tier per cell too, not just on the group — KIT_BUILT/KIT_UPGRADED
            # rows collapse into one group per player per bucket even though each cell in it
            # can be a different tier, so the group-level fields alone can't tell them apart.
            g["cells"].append({
                "x": row["x"], "y": row["y"], "id": row["id"],
                "old_tier": row["old_tier"], "new_tier": row["new_tier"],
            })

        cursor = raw[-1]["id"]

        if len(raw) < fetch_size:
            exhausted = True
            break
        if len(order) > limit:
            break  # a group started after the limit-th one — everything before it is complete

    limited_keys = order[:limit]
    result = [groups[k] for k in limited_keys]

    if not order:
        return result, None
    if len(limited_keys) == len(order):
        return result, (None if exhausted else cursor)

    # Trimmed to `limit` groups — resume after the smallest id among every
    # raw row that went into an included group.
    included = set(limited_keys)
    consumed_ids = [c["id"] for row_key in included for c in groups[row_key]["cells"]]
    return result, min(consumed_ids)


# ─── Player change log ───────────────────────────────────────────────────────

def last_player_stat(conn: sqlite3.Connection, world_uuid: str, uid: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM player_change_log WHERE world_uuid = ? AND uid = ? ORDER BY polled_at DESC, id DESC LIMIT 1",
        (world_uuid, uid),
    ).fetchone()


def insert_player_change(conn: sqlite3.Connection, world_uuid: str, uid: int, name: str,
                          empirevalue: int, outpost_count: int, delta_empirevalue: int, delta_outposts: int) -> None:
    conn.execute(
        """
        INSERT INTO player_change_log (world_uuid, uid, name, polled_at, empirevalue, outpost_count,
                                        delta_empirevalue, delta_outposts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (world_uuid, uid, name, now(), empirevalue, outpost_count, delta_empirevalue, delta_outposts),
    )


def activity_leaderboard(conn: sqlite3.Connection, world_uuid: str,
                          day_since: int, week_since: int, month_since: int) -> list[dict]:
    """Every player owning anything on this world, with current outpost count and gains/losses
    (not netted) per day/week/month, derived from world_events. Unpaginated; sort/filter client-side."""
    gains = conn.execute(
        """
        SELECT new_uid AS uid, MAX(new_name) AS name,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS gain_day,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS gain_week,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS gain_month
        FROM world_events
        WHERE world_uuid = ? AND event_type IN ('TAKEOVER', 'CLAIMED_FROM_WILD')
              AND new_uid IS NOT NULL AND new_uid > 0 AND detected_at >= ?
        GROUP BY new_uid
        """,
        (day_since, week_since, month_since, world_uuid, month_since),
    ).fetchall()
    losses = conn.execute(
        """
        SELECT old_uid AS uid, MAX(old_name) AS name,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS loss_day,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS loss_week,
               SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS loss_month
        FROM world_events
        WHERE world_uuid = ? AND event_type IN ('TAKEOVER', 'RECYCLED')
              AND old_uid IS NOT NULL AND old_uid > 0 AND detected_at >= ?
        GROUP BY old_uid
        """,
        (day_since, week_since, month_since, world_uuid, month_since),
    ).fetchall()
    outposts = conn.execute(
        """
        SELECT uid, MAX(name) AS name, COUNT(*) AS outpost_count
        FROM cells
        WHERE world_uuid = ? AND base_type = ? AND uid > 0
        GROUP BY uid
        """,
        (world_uuid, OUTPOST),
    ).fetchall()

    by_uid: dict[int, dict] = {}

    def entry(uid: int, name: str | None) -> dict:
        e = by_uid.get(uid)
        if e is None:
            e = {"uid": uid, "name": name, "outpost_count": 0,
                 "gain_day": 0, "gain_week": 0, "gain_month": 0,
                 "loss_day": 0, "loss_week": 0, "loss_month": 0}
            by_uid[uid] = e
        elif name and not e["name"]:
            e["name"] = name
        return e

    for row in gains:
        e = entry(row["uid"], row["name"])
        e["gain_day"], e["gain_week"], e["gain_month"] = row["gain_day"], row["gain_week"], row["gain_month"]
    for row in losses:
        e = entry(row["uid"], row["name"])
        e["loss_day"], e["loss_week"], e["loss_month"] = row["loss_day"], row["loss_week"], row["loss_month"]
    for row in outposts:
        entry(row["uid"], row["name"])["outpost_count"] = row["outpost_count"]

    return list(by_uid.values())


def empire_leaderboard(conn: sqlite3.Connection, world_uuid: str,
                        day_since: int, week_since: int, month_since: int) -> list[dict]:
    """Every player's current total empire value (all owned cells) plus net change per day/week/month.

    Distinct from activity_leaderboard(): this tracks total value, that
    tracks outpost turnover — they don't always move together.
    """
    totals = conn.execute(
        """
        SELECT uid, MAX(name) AS name, SUM(empirevalue) AS total_empirevalue, COUNT(*) AS total_cells
        FROM cells
        WHERE world_uuid = ? AND uid > 0
        GROUP BY uid
        """,
        (world_uuid,),
    ).fetchall()
    deltas = conn.execute(
        """
        SELECT uid,
               SUM(CASE WHEN polled_at >= ? THEN delta_empirevalue ELSE 0 END) AS delta_day,
               SUM(CASE WHEN polled_at >= ? THEN delta_empirevalue ELSE 0 END) AS delta_week,
               SUM(CASE WHEN polled_at >= ? THEN delta_empirevalue ELSE 0 END) AS delta_month
        FROM player_change_log
        WHERE world_uuid = ? AND polled_at >= ?
        GROUP BY uid
        """,
        (day_since, week_since, month_since, world_uuid, month_since),
    ).fetchall()
    delta_by_uid = {row["uid"]: row for row in deltas}

    result = []
    for row in totals:
        d = delta_by_uid.get(row["uid"])
        result.append({
            "uid": row["uid"], "name": row["name"],
            "total_empirevalue": row["total_empirevalue"], "total_cells": row["total_cells"],
            "delta_day": d["delta_day"] if d else 0,
            "delta_week": d["delta_week"] if d else 0,
            "delta_month": d["delta_month"] if d else 0,
        })
    return result


def inactive_players(conn: sqlite3.Connection, world_uuid: str, before: int) -> list[sqlite3.Row]:
    """Players whose most recent GAIN predates `before`. Losses don't reset the clock
    (that's someone else's activity against them, not their own); players who have
    never logged a gain don't appear here."""
    return conn.execute(
        """
        SELECT uid, MAX(name) AS name, MAX(polled_at) AS last_gained_at
        FROM player_change_log
        WHERE world_uuid = ? AND (delta_empirevalue > 0 OR delta_outposts > 0)
        GROUP BY uid
        HAVING last_gained_at < ?
        ORDER BY last_gained_at ASC
        """,
        (world_uuid, before),
    ).fetchall()
