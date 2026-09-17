import { MR2 } from "../../js/shared.js";

const OUTPOST_FLINGER_RANGE = [0, 1, 2, 3, 4];

// getarea is rate-limited server-side at 120 req/min/user.
const GETAREA_RATE_LIMIT_PER_MIN = 120;
const GETAREA_SAFETY_MARGIN = 0.85;
const GETAREA_REQUEST_INTERVAL_MS = Math.ceil(60000 / (GETAREA_RATE_LIMIT_PER_MIN * GETAREA_SAFETY_MARGIN));

/** Wires the export button — exports whichever world is currently selected. Called by app.js on /tnb/export/ only. */
export function wireExport(app) {
  const exportButton = document.getElementById("export-button");
  if (!exportButton) return;

  const exportLabel = document.getElementById("export-button-label");
  const warningEl = document.getElementById("export-resource-warning");
  const setLabel = (text) => { if (exportLabel) exportLabel.textContent = text; };

  const resourcesAvailable = () =>
    !!(app.session?.map?.worldid && app.selectedWorldId && app.session.map.worldid === app.selectedWorldId);

  setInterval(() => {
    if (exportButton.dataset.busy === "1") return;
    const hasWorld = !!app.selectedWorldId;
    exportButton.disabled = !hasWorld;
    exportButton.title = hasWorld
      ? "Export this world's players to a CSV."
      : "Waiting for a world to load…";

    if (warningEl) {
      const showWarning = hasWorld && !resourcesAvailable();
      warningEl.hidden = !showWarning;
      if (showWarning) {
        warningEl.textContent = app.session
          ? "You're logged in, but not into this world — the export will have no resource data."
          : "Not logged in — the export will have no resource data. Log in to include it for your own world.";
      }
    }
  }, 300);

  exportButton.addEventListener("click", async () => {
    if (!app.selectedWorldId) return;
    exportButton.disabled = true;
    exportButton.dataset.busy = "1";
    try {
      await exportCurrentWorld(app, setLabel, resourcesAvailable());
    } finally {
      setLabel("Export CSV");
      exportButton.disabled = false;
      delete exportButton.dataset.busy;
    }
  });
}

// Fetches the snapshot fresh over /api/snapshot rather than using app.renderer, so the CSV never reflects a stale map view.
async function exportCurrentWorld(app, setLabel, hasResources) {
  const worldId = app.selectedWorldId;
  const worldName = app.polledWorlds?.find((w) => w.uuid === worldId)?.name || worldId;

  setLabel("Fetching world data…");
  const { snapshot } = await app.api.getSnapshot(worldId);

  if (hasResources) {
    await backfillHomeResources(app, app.session.token, snapshot, setLabel);
  }

  setLabel("Building CSV…");
  const rows = buildRows(snapshot, { hasResources });
  downloadCsv(toCsv(rows, { hasResources }), worldName);
}

// Backfills home-base resources via getarea (the bulk snapshot omits them). Chunked by getarea's
// 11x11 response window so multiple homes in the same chunk share one request. Mutates
// snapshot.resourcesByUid, read back by buildRows() below.
async function backfillHomeResources(app, token, snapshot, setLabel) {
  const homesByUid = new Map(); // uid → {x, y}
  for (const row of snapshot.cells) {
    const [x, y, baseType, uid] = row;
    if (baseType === MR2.cellTypes.HOMECELL && uid > 0) homesByUid.set(uid, { x, y });
  }
  if (!homesByUid.size) return;

  const chunks = groupHomesByChunk([...homesByUid.values()]);
  const resourcesByCoord = new Map(); // "x,y" → resources object
  let homesDone = 0;

  for (let i = 0; i < chunks.length; i++) {
    setLabel?.(`Fetching resources… ${homesDone}/${homesByUid.size}`);
    await fetchChunkResources(app, token, chunks[i], resourcesByCoord);
    homesDone += chunks[i].homes.length;
    if (i < chunks.length - 1) await sleep(GETAREA_REQUEST_INTERVAL_MS);
  }
  setLabel?.(`Fetching resources… ${homesDone}/${homesByUid.size}`);

  snapshot.resourcesByUid = new Map();
  for (const [uid, pos] of homesByUid) {
    const r = resourcesByCoord.get(`${pos.x},${pos.y}`);
    if (r) snapshot.resourcesByUid.set(uid, r);
  }
}

function groupHomesByChunk(homes) {
  const byChunk = new Map(); // "originX,originY" → { originX, originY, homes[] }
  for (const home of homes) {
    const originX = Math.floor(home.x / 10) * 10;
    const originY = Math.floor(home.y / 10) * 10;
    const key = `${originX},${originY}`;
    let chunk = byChunk.get(key);
    if (!chunk) { chunk = { originX, originY, homes: [] }; byChunk.set(key, chunk); }
    chunk.homes.push(home);
  }
  return [...byChunk.values()];
}

async function fetchChunkResources(app, token, chunk, resourcesByCoord, attempt = 0) {
  try {
    const result = await app.api.getMapArea(token, chunk.originX, chunk.originY);
    for (const home of chunk.homes) {
      const fresh = result?.data?.[home.x]?.[home.y];
      if (fresh?.r) resourcesByCoord.set(`${home.x},${home.y}`, fresh.r);
    }
  } catch {
    if (attempt < 1) {
      await sleep(2000);
      return fetchChunkResources(app, token, chunk, resourcesByCoord, attempt + 1);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Works off a raw /api/snapshot payload directly — not app.renderer.cells.
function aggregatePlayers(snapshot) {
  const players = new Map(); // uid → { uid, name, home, outposts[] }
  for (const row of snapshot.cells) {
    const [x, y, baseType, uid, , , flinger] = row;
    if (!uid) continue;
    let entry = players.get(uid);
    if (!entry) {
      const name = snapshot.players?.[String(uid)]?.name || "Unknown";
      entry = { uid, name, home: null, outposts: [] };
      players.set(uid, entry);
    }
    if (baseType === MR2.cellTypes.HOMECELL) entry.home = { x, y };
    else if (baseType === MR2.cellTypes.OUTPOST) entry.outposts.push({ x, y, flinger });
  }
  return players;
}

function outpostFlingerRange(flingerLevel) {
  const lv = Number(flingerLevel) || 0;
  return OUTPOST_FLINGER_RANGE[lv] ?? 4;
}

// hasResources false leaves resource fields undefined; toCsv() renders them as "N/A", not 0.
function buildRows(snapshot, { hasResources }) {
  const players = aggregatePlayers(snapshot);
  const rows = [];
  for (const entry of players.values()) {
    const r = hasResources ? snapshot.resourcesByUid?.get(entry.uid) : null;
    let normalKits = 0, megaKits = 0, ultraKits = 0;
    for (const outpost of entry.outposts) {
      const range = outpostFlingerRange(outpost.flinger);
      if (range === 2) normalKits++;
      else if (range === 3) megaKits++;
      else if (range === 4) ultraKits++;
    }
    rows.push({
      name: entry.name,
      homeX: entry.home?.x ?? "",
      homeY: entry.home?.y ?? "",
      twigs: r?.r1,
      pebbles: r?.r2,
      putty: r?.r3,
      goo: r?.r4,
      resourceMax: r?.r1max ?? r?.r2max ?? r?.r3max ?? r?.r4max,
      outposts: entry.outposts.length,
      normalKits,
      megaKits,
      ultraKits,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// ─── CSV ─────────────────────────────────────────────────────────────────

const HEADERS = [
  "Name", "Home Coordinates",
  "Twigs", "Pebbles", "Putty", "Goo", "Resource Max Capacity",
  "Total Outposts",
  "Estimated Normal Kits", "Estimated Mega Kits", "Estimated Ultra Kits",
];

const NO_RESOURCE_DATA = "N/A (not logged into this world)";

function escapeCsvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, { hasResources }) {
  const lines = [HEADERS.join(",")];
  for (const row of rows) {
    const homeCoords = row.homeX === "" && row.homeY === "" ? "" : `${row.homeX}, ${row.homeY}`;
    const resourceField = (v) => (hasResources ? v ?? 0 : NO_RESOURCE_DATA);
    lines.push([
      row.name, homeCoords,
      resourceField(row.twigs), resourceField(row.pebbles), resourceField(row.putty),
      resourceField(row.goo), resourceField(row.resourceMax),
      row.outposts, row.normalKits, row.megaKits, row.ultraKits,
    ].map(escapeCsvField).join(","));
  }
  return lines.join("\r\n");
}

function downloadCsv(csvText, worldName) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = (worldName || "world").replace(/[^a-zA-Z0-9_-]+/g, "-");
  a.href = url;
  a.download = `bym-mr2-export-${safeName}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
