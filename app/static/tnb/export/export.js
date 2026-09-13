import { ViewerApp } from "../../js/viewer-app.js";
import { MR2 } from "../../js/shared.js";

const OUTPOST_FLINGER_RANGE = [0, 1, 2, 3, 4];

// getarea is rate-limited server-side at 120 req/min/user (getAreaLimiter) —
// stay comfortably under that rather than racing it.
const GETAREA_RATE_LIMIT_PER_MIN = 120;
const GETAREA_SAFETY_MARGIN = 0.85;
const GETAREA_REQUEST_INTERVAL_MS = Math.ceil(60000 / (GETAREA_RATE_LIMIT_PER_MIN * GETAREA_SAFETY_MARGIN));

window.addEventListener("DOMContentLoaded", () => {
  const app = new ViewerApp();
  app.start().catch((error) => {
    console.error(error);
    const status = document.getElementById("session-status");
    if (status) status.textContent = error.message || "Viewer failed to start.";
  });

  wireExport(app);
});

// ─── Session-state polling ────────────────────────────────────────────────────
// export.js is intentionally self-contained — it does not modify viewer-app.js,
// so it has no event hook for login/logout and just polls app.session instead.

function wireExport(app) {
  const exportButton = document.getElementById("export-button");
  if (!exportButton) return;

  const exportLabel  = document.getElementById("export-button-label");
  const modal        = document.getElementById("export-confirm-modal");
  const refreshBtn   = document.getElementById("export-refresh-button");
  const exportNowBtn = document.getElementById("export-now-button");
  const cancelBtn    = document.getElementById("export-cancel-button");

  const setLabel = (text) => { if (exportLabel) exportLabel.textContent = text; };
  const showModal = () => { if (modal) modal.hidden = false; };
  const hideModal = () => { if (modal) modal.hidden = true; };

  setInterval(() => {
    if (!app.session) return;
    if (exportButton.disabled && exportButton.dataset.busy !== "1") exportButton.disabled = false;
  }, 300);

  exportButton.addEventListener("click", async () => {
    if (!app.session) return;
    exportButton.disabled = true;
    exportButton.dataset.busy = "1";
    try {
      if (!app._isFullMapLoaded()) {
        setLabel("Loading full map…");
        await ensureBackgroundLoadDone(app);
        await backfillHomeResources(app, setLabel);
        setLabel("Export CSV");
        runExport(app);
        return;
      }
      showModal();
    } finally {
      exportButton.disabled = false;
      delete exportButton.dataset.busy;
    }
  });

  refreshBtn?.addEventListener("click", async () => {
    hideModal();
    exportButton.disabled = true;
    exportButton.dataset.busy = "1";
    try {
      setLabel("Refreshing…");
      await app._refreshMap();
      await ensureBackgroundLoadDone(app);
      await backfillHomeResources(app, setLabel);
      setLabel("Export CSV");
      runExport(app);
    } finally {
      exportButton.disabled = false;
      delete exportButton.dataset.busy;
    }
  });

  exportNowBtn?.addEventListener("click", () => {
    hideModal();
    runExport(app);
  });

  cancelBtn?.addEventListener("click", () => hideModal());
}

async function ensureBackgroundLoadDone(app) {
  if (app._bgLoadActive) {
    await new Promise((resolve) => {
      const check = () => (app._bgLoadActive ? setTimeout(check, 300) : resolve());
      check();
    });
    return;
  }
  await app._startBackgroundLoad();
}

// ─── Resource backfill ───────────────────────────────────────────────────────
// The viewer now loads the map from /worldmapv2/terrain + /worldmapv2/snapshot,
// which deliberately omit resources (`r`) — they change every tick and would
// break the bulk endpoints' cacheability. Since this export only ever reads
// resources off a player's HOME base (buildRows() below), the backfill only
// needs getarea data for HOME cells — bounded by MapRoom2.MAX_PLAYERS (2500),
// not by total occupied cells (which also counts every outpost and attacked
// wild camp, tens of thousands more).
//
// getarea also returns an 11x11 block from whatever (x, y) origin you give
// it, not just the one cell requested — so before fetching anything, homes
// are grouped ("deduped") by the 10-aligned chunk origin that would cover
// them. Any homes that happen to land in the same chunk are covered by a
// single request instead of one each, which only reduces the request count
// below MAX_PLAYERS — it never adds any.
async function backfillHomeResources(app, setLabel) {
  const homes = [];
  for (const cell of app.renderer.cells.values()) {
    if (cell.b === MR2.cellTypes.HOMECELL && cell.uid > 0) homes.push(cell);
  }
  if (!homes.length) return;

  const chunks = groupHomesByChunk(homes);
  const token  = app.session.token;
  let homesDone = 0;

  for (let i = 0; i < chunks.length; i++) {
    setLabel?.(`Fetching resources… ${homesDone}/${homes.length}`);
    await fetchChunkResources(app, token, chunks[i]);
    homesDone += chunks[i].homes.length;
    if (i < chunks.length - 1) await sleep(GETAREA_REQUEST_INTERVAL_MS);
  }
  setLabel?.(`Fetching resources… ${homesDone}/${homes.length}`);
}

// getarea's chunk origin is the multiple of 10 at or below the cell's
// coordinate — matches how the old chunk-crawl loader tiled the map, and
// guarantees the origin's 11x11 response (origin..origin+10) covers the cell.
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

async function fetchChunkResources(app, token, chunk, attempt = 0) {
  try {
    const result = await app.api.getMapArea(token, chunk.originX, chunk.originY);
    for (const home of chunk.homes) {
      const fresh = result?.data?.[home.x]?.[home.y];
      if (fresh?.r) home.r = fresh.r; // home is the same object stored in app.renderer.cells — mutate in place
    }
  } catch {
    // Likely a 429 despite the pacing above (another tab/consumer sharing the
    // same rate-limit bucket) — back off once and retry, then give up quietly
    // and leave this chunk's homes' resources blank rather than stall the export.
    if (attempt < 1) {
      await sleep(2000);
      return fetchChunkResources(app, token, chunk, attempt + 1);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Aggregation ───────────────────────────────────────────────────────────────

function aggregatePlayers(app) {
  const players = new Map(); // uid → { uid, name, home, outposts[] }
  for (const cell of app.renderer.cells.values()) {
    if (!cell.uid) continue; // skip terrain and wild monster cells (uid 0/undefined)
    let entry = players.get(cell.uid);
    if (!entry) {
      entry = { uid: cell.uid, name: cell.n || "Unknown", home: null, outposts: [] };
      players.set(cell.uid, entry);
    }
    if (cell.b === MR2.cellTypes.HOMECELL) entry.home = cell;
    else if (cell.b === MR2.cellTypes.OUTPOST) entry.outposts.push(cell);
  }
  return players;
}

function outpostFlingerRange(cell) {
  const lv = Number(cell.f) || 0;
  return OUTPOST_FLINGER_RANGE[lv] ?? 4;
}

function buildRows(app) {
  const players = aggregatePlayers(app);
  const rows = [];
  for (const entry of players.values()) {
    const r = entry.home?.r && typeof entry.home.r === "object" ? entry.home.r : {};
    let normalKits = 0, megaKits = 0, ultraKits = 0;
    for (const outpost of entry.outposts) {
      const range = outpostFlingerRange(outpost);
      if (range === 2) normalKits++;
      else if (range === 3) megaKits++;
      else if (range === 4) ultraKits++;
    }
    rows.push({
      name: entry.name,
      homeX: entry.home?.x ?? "",
      homeY: entry.home?.y ?? "",
      twigs: r.r1 ?? 0,
      pebbles: r.r2 ?? 0,
      putty: r.r3 ?? 0,
      goo: r.r4 ?? 0,
      resourceMax: r.r1max ?? r.r2max ?? r.r3max ?? r.r4max ?? 0,
      outposts: entry.outposts.length,
      normalKits,
      megaKits,
      ultraKits,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// ─── CSV ────────────────────────────────────────────────────────────────────────

const HEADERS = [
  "Name", "Home Coordinates",
  "Twigs", "Pebbles", "Putty", "Goo", "Resource Max Capacity",
  "Total Outposts",
  "Estimated Normal Kits", "Estimated Mega Kits", "Estimated Ultra Kits",
];

function escapeCsvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [HEADERS.join(",")];
  for (const row of rows) {
    const homeCoords = row.homeX === "" && row.homeY === "" ? "" : `${row.homeX}, ${row.homeY}`;
    lines.push([
      row.name, homeCoords,
      row.twigs, row.pebbles, row.putty, row.goo, row.resourceMax,
      row.outposts, row.normalKits, row.megaKits, row.ultraKits,
    ].map(escapeCsvField).join(","));
  }
  return lines.join("\r\n");
}

function downloadCsv(csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `bym-mr2-export-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function runExport(app) {
  downloadCsv(toCsv(buildRows(app)));
}
