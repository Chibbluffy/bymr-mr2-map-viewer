export const TOKEN_STORAGE_KEY = "bym-mr2-viewer-token";
export const SESSION_CACHE_DB_NAME = "bym-mr2-viewer-session-cache";
export const SERVER_SELECTION_STORAGE_KEY = "bym-mr2-viewer-server-selection";
export const SESSION_CACHE_STORE_NAME = "entries";
export const SESSION_CACHE_SESSION_KEY = "bym-mr2-viewer-session-id";
export const FULL_MAP_CACHE_VERSION = 1;
export const FULL_MAP_CACHE_KEY_PREFIX    = "bym-mr2-viewer-full-map";
export const LOADED_CHUNKS_CACHE_KEY_PREFIX = "bym-mr2-viewer-loaded-chunks";
export const HOME_POS_STORAGE_KEY_PREFIX    = "bym-mr2-viewer-home-pos";
export const SEARCH_RESULT_LIMIT = 80;

export const DEFAULT_VIEWER_CONFIG = Object.freeze({
  bymBaseUrl: "http://localhost:3001",
  cdnBaseUrl: "http://localhost:3001",
  apiVersion: "v1.6.2-beta",
});

export const STABLE_VIEWER_CONFIG = Object.freeze({
  bymBaseUrl: "https://server.bymrefitted.com",
  cdnBaseUrl: "https://cdn.bymrefitted.com",
  apiVersion: DEFAULT_VIEWER_CONFIG.apiVersion,
});

// ─── Map Room 2 geometry ──────────────────────────────────────────────────────
// Same staggered hex layout as MR3 — same game engine, same visual system.
export const MR2 = {
  mapWidth:  800,
  mapHeight: 800,
  hexWidth:  104,
  hexHeight: 68,
  hexVStep:  50,   // vertical step between rows (hexHeight - overlap)
  // No server-side rate limit on /worldmapv2/getcellsforviewer
  concurrency: 30,
  // Terrain height thresholds (MapRoomCell.as Update() / Terrain enum)
  terrain: {
    WATER1: 80,
    WATER2: 90,
    WATER3: 99,
    SAND1:  105,
    SAND2:  110,
    LAND1:  120,
    LAND2:  140,
    LAND3:  160,
    LAND4:  170,
    ROCK:   175,
    LAND6:  Infinity,
  },
  cellTypes: {
    WM:       1,   // wild monster tribe base
    HOMECELL: 2,   // player home
    OUTPOST:  3,   // player outpost
  },
};

// Hex floor vertices (same as MR3 viewer's FLOOR_HEX_VERTICES)
export const HEX_VERTICES = [
  [52, 3],
  [101, 19],
  [101, 49],
  [52, 65],
  [3, 49],
  [3, 19],
];

// ─── Terrain → tile asset path ───────────────────────────────────────────────
// MR2 shares the same worldmap tile assets as MR3.  Heights differ so we define
// our own mapping from MR2 terrain height ranges to tile filenames.
// Two-colour terrain palette — water vs land.
// Collapsed from 11 shades to avoid a mosaic of browns/greens bleeding through
// the semi-transparent occupant overlays.
export const MR2_TILE_DEFINITIONS = [
  { max: MR2.terrain.WATER3, fill: "#0f1c60" },  // all water depths — single dark navy
  { max: Infinity,           fill: "#28201a" },  // all land heights — single dark earth
];

export function getTileDef(i) {
  for (const def of MR2_TILE_DEFINITIONS) {
    if (i <= def.max) return def;
  }
  return MR2_TILE_DEFINITIONS[MR2_TILE_DEFINITIONS.length - 1];
}

export function isWater(i) {
  return i <= MR2.terrain.WATER3;
}

export function getTerrainLabel(i) {
  if (i <= MR2.terrain.WATER3) return "Water";
  if (i <= MR2.terrain.SAND2)  return "Sand";
  if (i <= MR2.terrain.LAND4)  return "Grass";
  if (i <= MR2.terrain.ROCK)   return "Rock";
  return "Rock";
}

// Wild monster tribes (same four as MR3)
export const TRIBES = ["Legionnaire", "Kozu", "Abunakki", "Dreadnaut"];

export function cellKey(x, y) {
  return `${x},${y}`;
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Config helpers ───────────────────────────────────────────────────────────

export function getViewerConfig() {
  if (getViewerConfig.cached) return getViewerConfig.cached;
  getViewerConfig.cached = getLocalViewerConfig();
  return getViewerConfig.cached;
}

export function setViewerConfig(config) {
  getViewerConfig.cached = normalizeViewerConfig(config);
  return getViewerConfig.cached;
}

export function getLocalViewerConfig() {
  const runtimeConfig =
    typeof window !== "undefined" && typeof window.BYM_MR_VIEWER_CONFIG === "object"
      ? window.BYM_MR_VIEWER_CONFIG
      : {};
  return normalizeViewerConfig({
    bymBaseUrl: runtimeConfig.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl,
    cdnBaseUrl: runtimeConfig.cdnBaseUrl || runtimeConfig.bymBaseUrl || DEFAULT_VIEWER_CONFIG.cdnBaseUrl,
    apiVersion: runtimeConfig.apiVersion || DEFAULT_VIEWER_CONFIG.apiVersion,
  });
}

export function normalizeViewerConfig(config) {
  return {
    bymBaseUrl: normalizeBaseUrl(config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl),
    cdnBaseUrl: normalizeBaseUrl(
      config?.cdnBaseUrl || config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.cdnBaseUrl,
    ),
    apiVersion: normalizeApiVersion(config?.apiVersion || DEFAULT_VIEWER_CONFIG.apiVersion),
  };
}

export function buildBymUrl(path, query = null, config = getViewerConfig()) {
  const url = new URL(`${config.bymBaseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query && typeof query === "object") {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}


export function buildSessionPayload(loginResponse, map) {
  const mp = map && typeof map === "object" ? map : {};
  const worldid =
    loginResponse?.worldid || loginResponse?.save?.worldid || loginResponse?.map?.worldid || mp.worldid || mp.worldId || "";
  const worldName =
    loginResponse?.worldname || loginResponse?.save?.worldname || mp.worldName || mp.worldname || "";
  return {
    token: loginResponse?.token || "",
    user: {
      userid:     loginResponse?.userid ?? loginResponse?.userId ?? null,
      username:   loginResponse?.username || "",
      email:      loginResponse?.email || "",
      pic_square: loginResponse?.pic_square || "",
    },
    map: { ...mp, worldid, worldName },
  };
}

export function normalizeBaseUrl(v) { return String(v || "").replace(/\/+$/, ""); }
export function normalizeApiVersion(v) {
  return String(v || DEFAULT_VIEWER_CONFIG.apiVersion).replace(/^\/+|\/+$/g, "");
}
export function buildTokenStorageKey(config) {
  return `${TOKEN_STORAGE_KEY}:${normalizeBaseUrl(config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl)}`;
}

export function parseJsonPayload(rawBody) {
  const text = String(rawBody || "").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  if (payload.errorDetails?.message?.trim()) return payload.errorDetails.message;
  if (payload.details) return extractErrorMessage(payload.details);
  if (typeof payload.raw === "string" && payload.raw.trim()) return payload.raw;
  return null;
}

export async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(error?.message ? `Unable to reach BYM server: ${error.message}` : "Unable to reach BYM server.");
  }
  const payload = parseJsonPayload(await response.text());
  if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
  return payload;
}

// ─── Cell IDs for bulk viewer loading ────────────────────────────────────────

// Generate 10x10 chunk origin coordinates sorted nearest-centre first.
// Used by the current /worldmapv2/getarea loader (6 400 chunks total).
// Switch to generateAllCellIds once /worldmapv2/getcellsforviewer is live.
export function generateChunkCoords() {
  const step = 10;
  const cx = MR2.mapWidth  / 2;
  const cy = MR2.mapHeight / 2;
  const coords = [];
  for (let y = 0; y < MR2.mapHeight; y += step) {
    for (let x = 0; x < MR2.mapWidth; x += step) {
      const dist = Math.hypot(x + step / 2 - cx, y + step / 2 - cy);
      coords.push({ x, y, dist });
    }
  }
  coords.sort((a, b) => a.dist - b.dist);
  return coords;
}

// Generate all 640 000 cell IDs sorted by squared distance from centre.
// Ready for /worldmapv2/getcellsforviewer once that endpoint is deployed.
// Uses TypedArrays (~10 MB peak) to avoid GC pressure from 640 K JS objects.
// Returns 1-based IDs: id = y * WIDTH + x + 1.
export function generateAllCellIds() {
  const W = MR2.mapWidth, H = MR2.mapHeight;
  const cx = W / 2, cy = H / 2;
  const total = W * H;

  const distSq = new Float32Array(total);
  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      distSq[y * W + x] = dx * dx + dy * dy;
    }
  }

  const indices = new Uint32Array(total);
  for (let i = 0; i < total; i++) indices[i] = i;
  indices.sort((a, b) => distSq[a] - distSq[b]);

  const ids = new Array(total);
  for (let i = 0; i < total; i++) ids[i] = indices[i] + 1;
  return ids;
}

// ─── IndexedDB session cache ─────────────────────────────────────────────────

let _db = null;

export function getSessionCacheSessionId() {
  let id = sessionStorage.getItem(SESSION_CACHE_SESSION_KEY);
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SESSION_CACHE_SESSION_KEY, id);
  }
  return id;
}

export async function ensureSessionCacheDb() {
  if (_db) return _db;
  _db = await new Promise((res, rej) => {
    const req = indexedDB.open(SESSION_CACHE_DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(SESSION_CACHE_STORE_NAME);
    req.onsuccess = (e) => res(e.target.result);
    req.onerror  = (e) => rej(e.target.error);
  });
  return _db;
}

export async function sessionCacheGet(key) {
  const db = await ensureSessionCacheDb();
  return new Promise((res, rej) => {
    const req = db.transaction(SESSION_CACHE_STORE_NAME, "readonly")
      .objectStore(SESSION_CACHE_STORE_NAME).get(key);
    req.onsuccess = (e) => res(e.target.result ?? null);
    req.onerror   = (e) => rej(e.target.error);
  });
}

export async function sessionCacheSet(key, value) {
  const db = await ensureSessionCacheDb();
  return new Promise((res, rej) => {
    const req = db.transaction(SESSION_CACHE_STORE_NAME, "readwrite")
      .objectStore(SESSION_CACHE_STORE_NAME).put(value, key);
    req.onsuccess = () => res();
    req.onerror   = (e) => rej(e.target.error);
  });
}

export async function sessionCacheDelete(key) {
  const db = await ensureSessionCacheDb();
  return new Promise((res, rej) => {
    const req = db.transaction(SESSION_CACHE_STORE_NAME, "readwrite")
      .objectStore(SESSION_CACHE_STORE_NAME).delete(key);
    req.onsuccess = () => res();
    req.onerror   = (e) => rej(e.target.error);
  });
}

export function buildFullMapCacheKey(userId, worldId) {
  return `${FULL_MAP_CACHE_KEY_PREFIX}:v${FULL_MAP_CACHE_VERSION}:${userId}:${worldId}`;
}

export function buildLoadedChunksCacheKey(userId, worldId) {
  return `${LOADED_CHUNKS_CACHE_KEY_PREFIX}:v${FULL_MAP_CACHE_VERSION}:${userId}:${worldId}`;
}

export function buildHomePosKey(userId, worldId) {
  return `${HOME_POS_STORAGE_KEY_PREFIX}:${userId}:${worldId}`;
}
