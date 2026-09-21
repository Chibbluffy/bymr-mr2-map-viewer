"""SQLite storage for polled MR2 world data.

`worlds` / `terrain` / `cells` — latest known state, overwritten each poll.
No history is kept — just the current occupied-cell snapshot per world,
which is all the map view, search, filters, and the (currently hidden)
Path tool need.
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
-- Overwritten each poll.
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
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
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
