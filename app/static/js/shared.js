export const TOKEN_STORAGE_KEY = "bym-mr2-viewer-token";
export const SESSION_CACHE_DB_NAME = "bym-mr2-viewer-session-cache";
export const SESSION_CACHE_STORE_NAME = "entries";
export const SESSION_CACHE_SESSION_KEY = "bym-mr2-viewer-session-id";
export const WORLD_CACHE_VERSION = 1;
export const TERRAIN_CACHE_KEY_PREFIX  = "bym-mr2-viewer-terrain";
export const SNAPSHOT_CACHE_KEY_PREFIX = "bym-mr2-viewer-snapshot";
export const HOME_POS_STORAGE_KEY_PREFIX    = "bym-mr2-viewer-home-pos";
export const SELECTED_WORLD_STORAGE_KEY     = "bym-mr2-viewer-selected-world";
export const ROUTE_STORAGE_KEY_PREFIX       = "bym-mr2-viewer-route";
export const VIEW_AS_STORAGE_KEY_PREFIX     = "bym-mr2-viewer-view-as";
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
  // Flat-top hex orientation (straight edges on top/bottom, points left/right)
  hexWidth:   104,  // full drawn width  (left point → right point)
  hexHeight:  68,   // full drawn height (top flat → bottom flat)
  hexColStep: 78,   // horizontal centre-to-centre distance = hexWidth * 3/4
  hexRowStep: 68,   // vertical   centre-to-centre distance = hexHeight
  hexColOffset: 34, // odd-column vertical shift = hexHeight / 2
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

// Mirrors server/src/enums/MapRoom.ts's MapRoomVersion — used to confirm an
// account's world is actually MR2 before trying to load it as one.
export const MapRoomVersion = { NONE: 0, V1: 1, V2: 2, V3: 3 };

// Flat-top hex vertices: straight edges on top/bottom, points on left/right.
// Bounding box 104 wide × 68 tall; vertices listed clockwise from upper-left.
export const HEX_VERTICES = [
  [26,  0],   // upper-left  (W/4,   0)
  [78,  0],   // upper-right (3W/4,  0)
  [104, 34],  // right point (W,     H/2)
  [78,  68],  // lower-right (3W/4,  H)
  [26,  68],  // lower-left  (W/4,   H)
  [0,   34],  // left point  (0,     H/2)
];

// Two-colour terrain palette (water/land) — collapsed from 11 shades to avoid
// a mosaic bleeding through the semi-transparent occupant overlays.
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

// ─── Wild-camp derivation ───────────────────────────────────────────────────
// Unattacked camps aren't in the bulk snapshot — computed here as a pure
// function of (x, y, worldid), mirroring the server's own formula exactly.

export const MIN_TRIBE_LEVEL = {
  Legionnaire: 25,
  Kozu: 29,
  Abunakki: 25,
  Dreadnaut: 25,
};

export function tribeAt(x, y) {
  return TRIBES[(x + y) % TRIBES.length];
}

export function levelAt(x, y) {
  const tribe = tribeAt(x, y);
  const low = MIN_TRIBE_LEVEL[tribe];
  return ((x + y) % (45 - low)) + low;
}

// FNV-1a hash of the world uuid, folded to 24 bits. Math.imul is required
// here to match the server's 32-bit multiply-with-wraparound.
function worldIdTo24Bit(worldId) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < worldId.length; i++) {
    hash ^= worldId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0xffffff;
}

// MR2 base ids carry no version prefix: [worldHash: 8][x: 3][y: 3] = 14 digits.
export function generateBaseId(worldId, x, y) {
  const worldHash = (worldIdTo24Bit(worldId) % 90000000) + 10000000;
  return `${worldHash}${String(x).padStart(3, "0")}${String(y).padStart(3, "0")}`;
}

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

// Terrain and snapshot are per-world, not per-viewer, so unlike the old
// per-chunk cache these keys aren't scoped by userId.
export function buildTerrainCacheKey(worldId) {
  return `${TERRAIN_CACHE_KEY_PREFIX}:v${WORLD_CACHE_VERSION}:${worldId}`;
}

export function buildSnapshotCacheKey(worldId) {
  return `${SNAPSHOT_CACHE_KEY_PREFIX}:v${WORLD_CACHE_VERSION}:${worldId}`;
}

export function buildHomePosKey(userId, worldId) {
  return `${HOME_POS_STORAGE_KEY_PREFIX}:${userId}:${worldId}`;
}

export function buildRouteStorageKey(worldId) {
  return `${ROUTE_STORAGE_KEY_PREFIX}:${worldId}`;
}

export function buildViewAsKey(worldId) {
  return `${VIEW_AS_STORAGE_KEY_PREFIX}:${worldId}`;
}
