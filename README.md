# BYM MR2 Viewer

BYM MR2 Viewer is a browser-based Map Room 2 viewer for Backyard Monsters Refitted. It lets you browse the 800×800 hex world map outside the game client, inspect bases, search for players, and filter cells — all from your browser.

## Requirements

None — the viewer shows every Map Room 2 world `poller.py` has polled (five, currently), picked from a dropdown, and works fully with no BYM account at all. There's no login: map data comes entirely from `poller.py`'s own polling (via a server-side API key, never exposed to the browser).

## About Map Room 2

Map Room 2 is the second-generation BYM world map — a staggered hex grid of 800×800 cells using a Perlin-noise-based altitude system. Terrain types are:

| Terrain | Height range | Description |
|---------|-------------|-------------|
| Water   | ≤ 99        | Deep/coastal water — impassable |
| Sand    | 100 – 110   | Coastal / shoreline sand |
| Grass   | 111 – 170   | Lowland and highland grass |
| Rock    | 171+        | High-altitude rocky ground |

Map Room 2 is distinct from Map Room 1 (the original non-hex indoor map room) and Map Room 3 (the newer, smaller 500×500 hex map).

## Features

The UI is a top bar (brand, world picker, View As) plus a full-bleed map — there's no permanent sidebar; everything else floats and is hidden until you need it. The top bar's own popover (View as) is positioned in JS off the real trigger button and clamped to the viewport width (`_positionPopover()` in `viewer-app.js`), not fixed-offset CSS — on a narrow phone screen a popover anchored to a button near one edge would otherwise run straight off the other side.

- **World picker** — pinned in the top bar; every MR2 world `poller.py` has polled, in one dropdown; switch worlds at any time
- Full 800×800 hex world map rendered on an interactive canvas
- Tile sprites from the shared `worldmap/` CDN asset path applied over terrain hexes
- Progressive map loading with a live progress indicator
- Always talks to the Stable game server — there's no server picker; an API key is required for map data (see How It Works below), so pointing the viewer at a local/custom server isn't a meaningful option anymore
- **"View as"** — a client-only stand-in identity, no login: type a username already visible on the world and the viewer matches it against currently-loaded cells to resolve a uid, entirely in the browser. Drives the "mine" highlight, find-home, Path route progress, and the alliance-relationship colors below.
- **Alliance-relationship map colors** — every occupied cell is colored like the original game client's own map room (`AllyInfo.as`'s `playerHex`/`allyHex`/`friendlyHex`/`hostileHex`/`neutralHex`/`noneHex`): neon cyan for the "View As" player's own bases, pale blue for their alliance-mates, green for an allied alliance, red for a declared enemy, yellow for any other alliance with no declared relation, white for no alliance at all. (Self is the one deliberate departure from the game's exact color — its flat medium blue got lost next to the pale alliance blue and the water's dark navy, so it's pure cyan at a near-opaque alpha instead of the muted-teal look a plain hue swap at the usual blend alpha still had; everything else matches exactly.) With no "View As" set (or one with no alliance of their own), everything just falls back to the yellow/white split, matching how the real client behaves with no alliance of its own to compare against. Backed by a new `/api/alliances` route (membership + declared relationships), fetched by `poller.py` once per cycle alongside each world's snapshot.
- **Home-base avatar markers** — a home base with a loaded player avatar shows that avatar filling the hex itself (clipped to the hex's exact outline, cover-fit so it crops rather than squishes, ringed in its relationship color) instead of a flat colored hex — the quickest way to tell a home base apart from an outpost (outposts stay plain hexes) and to recognize a specific player at a glance. Shown across almost the entire zoom range, not just when zoomed all the way in: unlike name/level text, a filled-in hex still reads as *something* well below the zoom level text needs, so it only disappears once hexes themselves degrade to plain filled rects for being too small (`RECT_ZOOM`). Avatars are lazy-loaded per URL and cached for the session; no avatar, a still-loading one, or a failed load just leaves the flat hex fill as-is.
- **Avatar in the cell-detail popup too** — the player-base detail panel's header shows their avatar at the top left, followed by base type and name (e.g. "Home Base: PlayerName") — coordinates aren't repeated there since they're already a detail row below. Shown for both home bases and outposts, not just home bases like the map markers above. Click it to enlarge in a lightbox; click anywhere (or `Escape`) to close.
- **Click a name in the detail panel to filter by them** — the "Player" row's name is underlined and clickable (with a "click to filter/highlight this player" tooltip); clicking pins them straight into the multi-player filter, same as adding them from the search dropdown.
- **"Go to Home" link on outposts** — an outpost's detail panel gets a one-click shortcut that pans the map straight to that same player's home base; home-base popups don't show it since you're already there.
- Search for player bases by username
- **Cell details as a floating panel**, not a fixed sidebar — hovering a cell shows a transient preview; clicking one "pins" it open (with a close button) so it stays up while you pan/zoom elsewhere
- Cell inspection — terrain, base type, player, alliance, level, damage, and protection status, all from the bulk polled snapshot (alliance from the separate `/api/alliances` route). Player-cell level isn't in that snapshot (only wild camps have one, computed client-side from coordinates) and shows as `?` — getting a real player level would need the game server's own `/worldmapv2/snapshot` to start including it.
- **Filter** by player (among other criteria) — pin multiple players at once; everyone starts out the same pink highlight (deliberately not auto-cycled, so a color never silently collides with something else's meaning, like the alliance system's yellow). Click a pinned player's name to give them their own color via the browser's native picker; the choice is remembered per player across visits (`localStorage`), not just for the current session.
- **Path tool** — plans a takeover route between two endpoints, one of three cost strategies, wraparound-aware hex A* search.
- **Measuring tool (ruler)** — click two points, or click-drag a line, to get the wraparound-aware hex-hop distance between any two spots on the map. Click an existing line to select it and reveal a small delete button; `Delete`/`Backspace` clears every ruler at once. Nothing here is persisted — refresh the page and every ruler is gone, by design.
- **Legend** — hidden by default, toggled from a button at the bottom right
- Home base jump button to re-centre on your base — enabled once View As is set; disabled otherwise rather than a silent no-op
- Keyboard shortcuts: `+`/`-` to zoom, `H` to jump home, `M` to toggle the measuring tool, `Delete`/`Backspace` to clear rulers, `Escape` to deselect/unpin/stop measuring — all correctly ignored while typing in any text field
- Zoom range is sane at both ends: the max is 1x — a hex at its native drawn size, ~104px wide — and the minimum is computed from the actual viewport, so "zoomed all the way out" means the whole map just fits. Past a large-enough visible area, rendering switches to a single pre-rendered whole-map texture instead of iterating every cell, so drag/pan stays cheap even at low zoom with hundreds of thousands of cells loaded. This still applies with a map filter active: filter matches are cached and only re-scanned when the filter or the underlying cell data actually changes, not on every frame. At the mid-zoom levels where neither optimization kicks in, name/level labels and grid lines (the expensive part — canvas text layout) are skipped for the handful of frames while you're actively dragging and redrawn once you let go, so panning stays smooth there too.
- Session cache via IndexedDB so subsequent visits skip the full reload

## How It Works

**The backend is server-side.** `/worldmapv2/terrain`, `/worldmapv2/snapshot`, and `/worldmapv2/alliances` each require an API key (`X-API-Key`) rather than a player login, and each is rate-limited to 10 requests/minute per key. A static browser page can't hold that key safely, so map data is fetched entirely server-side:

- **`poller.py`** runs continuously, polling every MR2 world (via the public, unauthenticated `/api/{v}/worlds`) every `POLL_INTERVAL_SECONDS` (10 minutes by default). It fetches each world's terrain once ever (immutable) and its snapshot each cycle, overwriting `data/mr2.sqlite3`'s `cells` table with the current state of every occupied cell; once per cycle it also fetches `/worldmapv2/alliances` (one call covers every MR2 world) and overwrites the `alliances` table. No history is tracked — just the current snapshot, refreshed each cycle.
- **`server.py`** serves the static viewer files *and* a small read-only JSON API on top of that database (`/api/worlds`, `/api/terrain`, `/api/snapshot`, `/api/alliances`) — same origin as the static files, so no CORS to configure. The real API key never leaves this process.

The browser-side viewer's map-loading code (`api-client.js`'s `getTerrain`/`getSnapshot`/`getAlliances`/`getPolledWorlds`) calls `server.py`'s relative `/api/terrain`, `/api/snapshot`, `/api/alliances`, and `/api/worlds` — **the page must be served by `server.py`, not `dev_server.py`**, or those calls 404 (`dev_server.py` is a plain static file server with no routes of its own).

There's no login and no per-cell live detail beyond what the bulk snapshot already carries — the viewer only ever talks to `server.py`'s own routes, never the real game server directly.

## Running It — Backend

Requires Python 3 and an API key from the BYM dev (nothing else — no extra dependencies, SQLite and everything else here is stdlib).

```bash
cp .env.example .env   # fill in BYM_API_KEY
python3 poller.py      # keeps data/mr2.sqlite3 up to date; run continuously
python3 server.py      # serves the site + the JSON API; run continuously
```

Then open `http://localhost:8081`. Run both processes together (two terminals, two systemd units, whatever fits your host) — `server.py` only reads the database, `poller.py` is the only thing that writes it or holds the API key.

**Deploying to a real server** (systemd units, an nginx reverse-proxy config, and an optional GitHub Actions deploy-on-push workflow) — see [`deploy/README.md`](deploy/README.md).

### Config (env var, or set in `.env`)

| Variable                | Default                                | Description                                    |
|--------------------------|-----------------------------------------|-------------------------------------------------|
| `BYM_API_KEY`            | *(required)*                            | From the BYM dev. Never sent to the browser.    |
| `BYM_BASE_URL`           | `https://server.bymrefitted.com`        | Game server the poller polls                    |
| `BYM_API_VERSION`        | `v1.6.2-beta`                           | Used to build the `/worlds` URL                 |
| `POLL_INTERVAL_SECONDS`  | `600`                                   | How often the poller re-fetches every world     |
| `HOST`                   | `0.0.0.0`                               | Interface `server.py` listens on                |
| `PORT`                   | `8081`                                  | Port to serve on (MR3 uses 8080)                |
| `STATIC_DIR`             | `app/static`                            | Path to the static file root                    |

`dev_server.py` still exists (plain static file server, no `/api/*` routes) but no longer serves a working map on its own now that the browser code expects `server.py` — it's only useful if you're doing frontend-only work against static assets and don't need real map data.

## Map Legend

The map itself only ever renders two terrain colours — water and land — not a shade per
height band, so the in-app legend doesn't list Sand/Grass/Rock separately (see the terrain
table under "About Map Room 2" above for the actual height thresholds, which the Terrain
filter still uses even though the map's own fill doesn't visually distinguish them).

Occupied cells are colored by alliance relationship to whoever "View As" is set to —
see the "Alliance-relationship map colors" bullet under Features above for the exact
semantics — using the original game client's own colors:

| Colour     | Meaning                                          |
|------------|---------------------------------------------------|
| Dark blue  | Water — impassable                                 |
| Neon cyan  | Self — the "View As" player's own bases (deliberately not the game's own flat blue — see above) |
| Pale blue  | Your alliance — a fellow member                    |
| Green      | An allied alliance (your alliance declared them a friend) |
| Red        | An enemy alliance (your alliance declared them hostile) |
| Yellow     | Any other alliance — no declared relation, or no "View As" set at all |
| White      | No alliance                                        |
| Light grey | Wild monster tribe base                            |
