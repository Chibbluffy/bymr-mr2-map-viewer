# BYM MR2 Viewer

BYM MR2 Viewer is a browser-based Map Room 2 viewer for Backyard Monsters Refitted. It lets you browse the 800×800 hex world map outside the game client, inspect bases, search for players, and view live map data — all from your browser.

## Requirements

You must be an active Map Room 2 player. The viewer authenticates as your BYM account and reads data from the world your account currently occupies on Map Room 2. If your account has not joined a Map Room 2 world, the viewer will not be able to load map data.

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

- Full 800×800 hex world map rendered on an interactive canvas
- Tile sprites from the shared `worldmap/` CDN asset path applied over terrain hexes
- Progressive map loading with a live progress indicator
- Defaults to the Stable server — no manual IP entry needed
- Per-user sign-in with your own BYM credentials
- Search for player bases by username
- Cell inspection — terrain, base type, player, level, damage, and protection status
- Home base jump button to re-centre on your base
- Keyboard shortcuts: `+`/`-` to zoom, `H` to jump home, `Escape` to deselect
- Leaderboard panel for MR2 worlds
- Session cache via IndexedDB so subsequent visits skip the full reload

## How It Works

The viewer runs entirely in your browser. After signing in, it connects directly to the selected BYM server for authentication and map data — no credentials or map data pass through any separate backend.

Map data is fetched using the `/worldmapv2/getarea` endpoint, which returns cells in 10×10 chunk blocks. The viewer queues all 6 400 chunks (the full 800×800 grid) and fetches them with up to 30 concurrent requests, loading from the centre of the map outward so your home area becomes visible quickly. On a local server this typically completes in well under a minute.

## Credentials and Privacy

Your BYM email and password are sent only to the server you select in the dropdown:

- `Stable` (default) — the live Backyard Monsters Refitted server
- `Local` — your local BYM server at `http://localhost:3001`
- `Custom` — a custom host and port you enter

## Running It Locally

Python 3 is required.

From the project root, run:

```bash
python3 dev_server.py
```

Then open:

```
http://localhost:8081
```

## Optional Server Settings

| Variable     | Default       | Description                     |
|--------------|---------------|---------------------------------|
| `HOST`       | `0.0.0.0`     | Interface to listen on          |
| `PORT`       | `8081`        | Port to serve on (MR3 uses 8080)|
| `STATIC_DIR` | `app/static`  | Path to the static file root    |

Example:

```bash
PORT=9090 python3 dev_server.py
```

## Map Legend

| Colour       | Meaning                        |
|--------------|--------------------------------|
| Dark blue    | Water — impassable             |
| Sandy brown  | Sand — coastal terrain         |
| Green shades | Grass — lowland/highland       |
| Grey / stone | Rock — high-altitude terrain   |
| Cyan outline | Your base or outpost           |
| Red-orange   | Enemy player base              |
| Purple       | Wild monster tribe base        |
