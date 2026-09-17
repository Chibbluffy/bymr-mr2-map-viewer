import { MR2, HEX_VERTICES, cellKey, getTileDef, isWater, tribeAt, levelAt, generateBaseId } from "./shared.js";

// ─── Geometry constants ─────────────────────────────────────────────────────
// Flat-top hex grid, offset columns (odd columns shift down by half hex height).
const HW  = MR2.hexWidth;
const HH  = MR2.hexHeight;
const CS  = MR2.hexColStep;
const RS  = MR2.hexRowStep;
const CO  = MR2.hexColOffset;

const MIN_ZOOM_FLOOR = 0.005; // fallback before the canvas has a real size — see _minZoomForViewport()
const MAX_ZOOM    = 1; // zoom 1 = a hex at its native drawn size (HW×HH px, ~104×68)
const ZOOM_STEP   = 1.2;
const LABEL_ZOOM  = 0.45;
const LABEL_FULL_ZOOM = 0.75;
const GRID_ZOOM   = 0.15;

const RECT_ZOOM = 0.08; // below this hexes are <8px wide; fillRect looks identical and is faster

// Past this many visible cells, _render() blits a pre-rendered whole-map
// texture (_rebuildWorldTexture()) instead of iterating per cell — the fix
// for drag lag at low zoom. Also used (with a dim/highlight pass on top)
// when a filter is active — see _getFilterMatchPositions().
const TEXTURE_CELL_THRESHOLD = 120_000;

// ─── Cell overlay colours ───────────────────────────────────────────────────
const COL_MINE              = "#00e8ff";
const COL_MINE_HOME_FILL    = "rgba(0,232,255,0.88)";
const COL_MINE_OUT_FILL     = "rgba(0,170,230,0.50)";
const COL_OTHER_HOME_FILL   = "rgba(255,210,30,0.90)";
const COL_OTHER_OUT_FILL    = "rgba(255,130,0,0.55)";
const COL_WM_FILL           = "rgba(200,200,200,0.35)";

// Reserved for future relationship colours: alliance (green), truce (purple).

const COL_HOVER_FILL  = "rgba(255,255,255,0.20)";
const COL_SELECTED_ST = "rgba(255,210,0,0.92)";
const COL_SELECTED_FL = "rgba(255,210,0,0.30)";
const COL_FILTER_FILL = "rgba(255,50,200,0.72)";
const COL_DIM_FILL    = "rgba(0,0,0,0.38)";

const COL_ROUTE_LINE    = "#39ff6a";
const COL_ROUTE_START   = "#ffffff";
const COL_ROUTE_BLOCKED = "#ff4444";

// Numeric RGB(+alpha) equivalents of the above, for _rebuildWorldTexture()'s
// per-pixel ImageData writes. Kept in sync by hand.
const RGB_WATER = [15, 28, 96];
const RGB_LAND  = [40, 32, 26];
const RGB_MINE_HOME  = [0, 232, 255],  A_MINE_HOME  = 0.88;
const RGB_MINE_OUT   = [0, 170, 230],  A_MINE_OUT   = 0.50;
const RGB_OTHER_HOME = [255, 210, 30], A_OTHER_HOME = 0.90;
const RGB_OTHER_OUT  = [255, 130, 0],  A_OTHER_OUT  = 0.55;
const RGB_WM_TEX     = [200, 200, 200], A_WM_TEX    = 0.35;

function blendRGB(base, overlay, alpha) {
  return [
    base[0] + (overlay[0] - base[0]) * alpha,
    base[1] + (overlay[1] - base[1]) * alpha,
    base[2] + (overlay[2] - base[2]) * alpha,
  ];
}

// ─── Hex helpers ────────────────────────────────────────────────────────────

function cellToWorld(cx, cy) {
  return {
    x: cx * CS,
    y: cy * RS + (cx % 2 !== 0 ? CO : 0),
  };
}

/**
 * Smallest span of `values` on a circular axis of the given period — finds
 * the largest gap between consecutive sorted values (wrapping) and returns
 * the span covering everything else, i.e. the tightest bounding range for a
 * cluster of points that may straddle the wrap seam. Result may extend past
 * [0, period), e.g. {min: -5, max: 12} — callers (cellToWorld()) only care
 * about linear position, not staying in-bounds.
 */
function minimalCircularSpan(values, period) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length <= 1) return { min: sorted[0] ?? 0, max: sorted[0] ?? 0 };

  let maxGap = -Infinity, gapAt = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + period;
    const gap = next - sorted[i];
    if (gap > maxGap) { maxGap = gap; gapAt = i; }
  }

  const startIdx = (gapAt + 1) % sorted.length;
  let prev = sorted[startIdx];
  const min = prev;
  let max = prev;
  for (let k = 1; k < sorted.length; k++) {
    let v = sorted[(startIdx + k) % sorted.length];
    if (v < prev) v += period;
    max = v;
    prev = v;
  }
  return { min, max };
}

function worldToCell(wx, wy) {
  const approxCol = Math.round(wx / CS);
  const offset    = approxCol % 2 !== 0 ? CO : 0;
  const approxRow = Math.round((wy - offset) / RS);

  let best = null, bestDist = Infinity;
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      const c = approxCol + dc, r = approxRow + dr;
      if (c < 0 || c >= MR2.mapWidth || r < 0 || r >= MR2.mapHeight) continue;
      const { x: wx2, y: wy2 } = cellToWorld(c, r);
      const dist = Math.hypot(wx - (wx2 + HW / 2), wy - (wy2 + HH / 2));
      if (dist < bestDist) { bestDist = dist; best = { x: c, y: r }; }
    }
  }
  return best;
}

function hexPath(ctx, sx, sy, zoom) {
  ctx.beginPath();
  for (let i = 0; i < HEX_VERTICES.length; i++) {
    const px = sx + HEX_VERTICES[i][0] * zoom;
    const py = sy + HEX_VERTICES[i][1] * zoom;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ─── MapRenderer ────────────────────────────────────────────────────────────

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");

    this.cells   = new Map();
    this._cellsVersion = 0; // bumped whenever cells is bulk-replaced or mutated — invalidates _filterMatchCache
    this._realLevelByUid = new Map(); // uid -> real level learned from getarea — see normalizeCellLevel()
    this._worldTexture = null;
    this._filterMatchCache = null; // { filter, cellsVersion, positions } — see _getFilterMatchPositions()
    this.myUserId = null;
    this.zoom    = 0.25;
    this.viewX   = (MR2.mapWidth  * CS) / 2 - canvas.clientWidth  / (2 * this.zoom);
    this.viewY   = (MR2.mapHeight * RS + CO) / 2 - canvas.clientHeight / (2 * this.zoom);

    this.hoveredCell  = null;
    this.selectedCell = null;
    this.filter       = null;
    this.route        = null; // set by ViewerApp's Path tool — see setRoute()

    this._dragging   = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragViewX  = 0;
    this._dragViewY  = 0;
    this._hasDragged = false;

    this._dirty = true;
    this._rafId = null;
    this._viewportChangeTimer = null;

    this.onCellHover      = null;
    this.onCellClick      = null;
    this.onCoordsChange   = null;
    this.onViewportChanged = null; // fires ~250ms after a pan/zoom

    this._bindEvents();
    this._scheduleRender();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Ingests a /worldmapv2/getarea response for click-to-enrich detail. */
  ingestArea(areaData) {
    for (const [xStr, row] of Object.entries(areaData)) {
      const cx = parseInt(xStr, 10);
      for (const [yStr, data] of Object.entries(row)) {
        const cy = parseInt(yStr, 10);
        if (cx < 0 || cx >= MR2.mapWidth || cy < 0 || cy >= MR2.mapHeight) continue;
        this.cells.set(cellKey(cx, cy), Object.assign({}, data, { x: cx, y: cy }));
      }
    }
    this._cellsVersion++;
    this.markDirty();
  }

  /** Rebuilds the entire map from terrain bytes + a snapshot payload. Safe to call again on every poll. */
  loadWorld(terrainBytes, snapshot) {
    const W = MR2.mapWidth, H = MR2.mapHeight;
    const cells = new Map();

    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const i = terrainBytes[x * H + y];
        if (i <= MR2.terrain.WATER3) {
          cells.set(cellKey(x, y), { x, y, i });
          continue;
        }
        // Unattacked wild monster camp — never persisted server-side either.
        cells.set(cellKey(x, y), {
          x, y, i,
          uid: 0,
          b: MR2.cellTypes.WM,
          bid: generateBaseId(snapshot.worldid, x, y),
          n: tribeAt(x, y),
          l: levelAt(x, y),
          dm: 0,
          d: 0,
        });
      }
    }

    this.cells = cells;
    this._applySnapshot(snapshot);
    this._normalizePlayerLevels();
    this._rebuildWorldTexture();
    this._recomputeRouteStatus();
    this._cellsVersion++;
    this.markDirty();
  }

  // The bulk snapshot has no level for player cells; _applySnapshot() clears
  // `l` for them. A level is account-wide (calculateBaseLevel() on the
  // server, not per-cell), so once learned via getarea it applies to every
  // cell that player owns — re-fills from this._realLevelByUid here.
  _normalizePlayerLevels() {
    for (const cell of this.cells.values()) {
      if (!(cell.uid > 0)) continue;
      const known = this._realLevelByUid.get(cell.uid);
      cell.l = known; // undefined shows "?" until getarea has told us otherwise
    }
  }

  /** Records a real level from getarea and propagates it to every other loaded cell for that uid. */
  normalizeCellLevel(cell) {
    if (!cell || !(cell.uid > 0)) return cell;
    if (cell.l !== undefined && cell.l !== null) {
      this._realLevelByUid.set(cell.uid, cell.l);
      for (const other of this.cells.values()) {
        if (other.uid === cell.uid && other !== cell) other.l = cell.l;
      }
      return cell;
    }
    const known = this._realLevelByUid.get(cell.uid);
    return known === undefined ? cell : { ...cell, l: known };
  }

  // One-pixel-per-cell rasterization of terrain + ownership colour, built
  // once per world load and blitted via drawImage() when the visible area
  // is too large for per-cell rendering — see TEXTURE_CELL_THRESHOLD.
  _rebuildWorldTexture() {
    const W = MR2.mapWidth, H = MR2.mapHeight;
    if (!this._worldTexture) this._worldTexture = document.createElement("canvas");
    const tex = this._worldTexture;
    tex.width = W;
    tex.height = H;

    const tctx = tex.getContext("2d", { willReadFrequently: false });
    const img = tctx.createImageData(W, H);
    const data = img.data;

    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = this.cells.get(cellKey(x, y));
        const height = cell?.i ?? 0;
        let rgb = isWater(height) ? RGB_WATER : RGB_LAND;

        if (!isWater(height) && cell && cell.b !== undefined) {
          const isHome = cell.b === MR2.cellTypes.HOMECELL;
          if (cell.uid === 0) {
            rgb = blendRGB(rgb, RGB_WM_TEX, A_WM_TEX);
          } else if (cell.mine === 1) {
            rgb = blendRGB(rgb, isHome ? RGB_MINE_HOME : RGB_MINE_OUT, isHome ? A_MINE_HOME : A_MINE_OUT);
          } else {
            rgb = blendRGB(rgb, isHome ? RGB_OTHER_HOME : RGB_OTHER_OUT, isHome ? A_OTHER_HOME : A_OTHER_OUT);
          }
        }

        const idx = (y * W + x) * 4;
        data[idx]     = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }

    tctx.putImageData(img, 0, 0);
  }

  // Blits the pre-rendered texture cropped to the current viewport.
  _drawWorldTexture() {
    const { ctx, zoom } = this;
    const tex = this._worldTexture;
    if (!tex) return;

    const canvasW = this.canvas.clientWidth, canvasH = this.canvas.clientHeight;
    const texX0 = this.viewX / CS, texX1 = (this.viewX + canvasW / zoom) / CS;
    const texY0 = this.viewY / RS, texY1 = (this.viewY + canvasH / zoom) / RS;

    const sx = Math.max(0, Math.min(MR2.mapWidth,  texX0));
    const sy = Math.max(0, Math.min(MR2.mapHeight, texY0));
    const sx2 = Math.max(0, Math.min(MR2.mapWidth,  texX1));
    const sy2 = Math.max(0, Math.min(MR2.mapHeight, texY1));
    if (sx2 <= sx || sy2 <= sy) return;

    const spanX = texX1 - texX0, spanY = texY1 - texY0;
    const dx = (sx - texX0) / spanX * canvasW;
    const dy = (sy - texY0) / spanY * canvasH;
    const dw = (sx2 - sx) / spanX * canvasW;
    const dh = (sy2 - sy) / spanY * canvasH;

    ctx.drawImage(tex, sx, sy, sx2 - sx, sy2 - sy, dx, dy, dw, dh);
  }

  _applySnapshot(snapshot) {
    const { players, cells: rows } = snapshot;
    const now = Math.floor(Date.now() / 1000);

    for (const row of rows) {
      const [x, y, baseType, uid, bid, empirevalue, flinger, catapult, damage, protectedUntil, destroyed] = row;
      if (x < 0 || x >= MR2.mapWidth || y < 0 || y >= MR2.mapHeight) continue;

      const key = cellKey(x, y);
      const existing = this.cells.get(key) || { x, y };

      const protectionExpired = protectedUntil > 0 && protectedUntil <= now;
      const isProtected = protectedUntil > 0 && !protectionExpired;

      const cell = {
        ...existing,
        x, y,
        b: baseType,
        uid,
        bid,
        v: empirevalue,
        f: flinger,
        c: catapult,
        p: isProtected ? 1 : 0,
        protected: protectedUntil,
      };

      if (baseType === MR2.cellTypes.WM) {
        cell.dm = damage;
        cell.d  = destroyed;
      } else {
        const owner = players[uid];
        cell.n = owner?.name ?? existing.n;
        cell.l = undefined; // no real level from the bulk snapshot — see _normalizePlayerLevels()
        cell.pic_square = owner?.avatar ?? undefined;
        cell.im = owner?.avatar ?? undefined;
        cell.mine = uid === this.myUserId ? 1 : 0;
        const displayDamage = protectionExpired ? 0 : damage;
        cell.dm = displayDamage;
        cell.d  = displayDamage >= 90 ? 1 : 0;
      }

      this.cells.set(key, cell);
    }
  }

  clearCells() {
    this.cells.clear();
    this._realLevelByUid.clear();
    this._worldTexture = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this._cellsVersion++;
    this.markDirty();
  }

  centerOn(cx, cy) {
    const { x, y } = cellToWorld(cx, cy);
    this.viewX = x + HW / 2 - this.canvas.clientWidth  / (2 * this.zoom);
    this.viewY = y + HH / 2 - this.canvas.clientHeight / (2 * this.zoom);
    this._clampView();
    this.markDirty();
  }

  /** Zooms/pans so every cell in `cellList` is visible, wraparound-aware. */
  fitToCells(cellList, { paddingFraction = 0.18 } = {}) {
    if (!cellList || !cellList.length) return;
    const canvasW = this.canvas.clientWidth, canvasH = this.canvas.clientHeight;
    if (!canvasW || !canvasH) return;

    const spanX = minimalCircularSpan(cellList.map((c) => c.x), MR2.mapWidth);
    const spanY = minimalCircularSpan(cellList.map((c) => c.y), MR2.mapHeight);

    const topLeft     = cellToWorld(spanX.min, spanY.min);
    const bottomRight = cellToWorld(spanX.max, spanY.max);
    const boxW = Math.max(HW, bottomRight.x - topLeft.x + HW);
    const boxH = Math.max(HH, bottomRight.y - topLeft.y + HH);
    const centerX = (topLeft.x + bottomRight.x) / 2 + HW / 2;
    const centerY = (topLeft.y + bottomRight.y) / 2 + HH / 2;

    const pad = 1 + paddingFraction * 2;
    const fitZoom = Math.min(canvasW / (boxW * pad), canvasH / (boxH * pad));
    const zoom = Math.max(this._minZoomForViewport(), Math.min(MAX_ZOOM, fitZoom));

    this.zoom = zoom;
    this.viewX = centerX - canvasW  / (2 * zoom);
    this.viewY = centerY - canvasH / (2 * zoom);
    this._clampView();
    this.markDirty();
  }

  // Minimum zoom that still fits the whole map on the current canvas (0.9x margin).
  _minZoomForViewport() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return MIN_ZOOM_FLOOR;
    const mapW = MR2.mapWidth  * CS + HW / 4;
    const mapH = MR2.mapHeight * RS + CO;
    return Math.max(MIN_ZOOM_FLOOR, 0.9 * Math.min(W / mapW, H / mapH));
  }

  setZoom(newZoom, pivotSX, pivotSY) {
    const clamped = Math.max(this._minZoomForViewport(), Math.min(MAX_ZOOM, newZoom));
    const wx = pivotSX / this.zoom + this.viewX;
    const wy = pivotSY / this.zoom + this.viewY;
    this.zoom  = clamped;
    this.viewX = wx - pivotSX / this.zoom;
    this.viewY = wy - pivotSY / this.zoom;
    this._clampView();
    this.markDirty();
    this._scheduleViewportChange();
  }

  _scheduleViewportChange() {
    clearTimeout(this._viewportChangeTimer);
    this._viewportChangeTimer = setTimeout(() => {
      if (this.onViewportChanged) this.onViewportChanged();
    }, 250);
  }

  zoomIn()  { this.setZoom(this.zoom * ZOOM_STEP, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); }
  zoomOut() { this.setZoom(this.zoom / ZOOM_STEP, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); }

  markDirty() { this._dirty = true; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(this.canvas.clientWidth  * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const minZoom = this._minZoomForViewport();
    if (this.zoom < minZoom) this.zoom = minZoom;
    this._clampView();
    this.markDirty();
  }

  findHomeCell() {
    for (const cell of this.cells.values()) {
      if (cell.mine === 1 && cell.b === MR2.cellTypes.HOMECELL) return cell;
    }
    return null;
  }

  getCellAt(cx, cy) { return this.cells.get(cellKey(cx, cy)) ?? null; }

  getPlayerCells() {
    const seen = new Map();
    for (const cell of this.cells.values()) {
      if (cell.uid > 0 && cell.n) {
        const k = cell.n.toLowerCase();
        const existing = seen.get(k);
        if (!existing || (cell.b === 2 && existing.b !== 2)) seen.set(k, cell);
      }
    }
    return [...seen.values()];
  }

  setFilter(filter) { this.filter = filter; this.markDirty(); }

  // ─── Path tool's route overlay ────────────────────────────────────────────

  /** route: findRoute() result. myUid: identity to track progress against. originalOwners: uid per path cell at plan time. */
  setRoute(route, myUid, originalOwners) {
    this.route = route ? { ...route, myUid, originalOwners } : null;
    this._recomputeRouteStatus();
    this.markDirty();
  }

  clearRoute() {
    this.route = null;
    this.markDirty();
  }

  getRouteProgress() {
    if (!this.route) return null;
    const counts = { completed: 0, blocked: 0, pending: 0, total: this.route.path.length - 1 };
    for (let i = 1; i < this.route.path.length; i++) {
      const status = this.route.hopStatus?.[i];
      if (status === "completed") counts.completed++;
      else if (status === "blocked") counts.blocked++;
      else counts.pending++;
    }
    return counts;
  }

  // Derives each hop's pending/completed/blocked status against current ownership.
  _recomputeRouteStatus() {
    if (!this.route) return;
    const { path, myUid, originalOwners } = this.route;
    const hopStatus = new Array(path.length).fill(undefined);
    for (let i = 1; i < path.length; i++) {
      const cell = this.getCellAt(path[i].x, path[i].y);
      const currentUid  = cell?.uid ?? 0;
      const originalUid = originalOwners?.[i] ?? 0;
      if (myUid != null && currentUid === myUid) hopStatus[i] = "completed";
      else if (currentUid === originalUid) hopStatus[i] = "pending";
      else hopStatus[i] = "blocked";
    }
    this.route.hopStatus = hopStatus;
  }

  countFilterMatches() {
    if (!this._hasActiveFilter()) return 0;
    return this._getFilterMatchPositions().length / 2;
  }

  // Flat [x, y, x, y, ...] world-cell coords of every filter match, cached by (filter,
  // cellsVersion) so a drag/zoom while zoomed way out doesn't re-scan all 640k cells
  // every frame — only the texture-blit render path (extreme zoom-out) uses this.
  _getFilterMatchPositions() {
    const cache = this._filterMatchCache;
    if (cache && cache.filter === this.filter && cache.cellsVersion === this._cellsVersion) {
      return cache.positions;
    }
    const positions = [];
    for (const cell of this.cells.values()) {
      if (this._cellMatchesFilter(cell)) positions.push(cell.x, cell.y);
    }
    this._filterMatchCache = { filter: this.filter, cellsVersion: this._cellsVersion, positions };
    return positions;
  }

  _hasActiveFilter() {
    if (!this.filter) return false;
    const { playerName, filterPlayerUids, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange, flingerLevels } = this.filter;
    return !!(playerName || filterPlayerUids?.size || baseTypes.size || terrainTypes.size || towerBonusRange || resourceBonusRange || flingerLevels?.size);
  }

  // AND between active filter groups; OR within each group.
  _cellMatchesFilter(cell) {
    const f = this.filter;
    if (!f) return false;
    const i = cell.i ?? 0;

    if (f.filterPlayerUids?.size) {
      if (!f.filterPlayerUids.has(cell.uid)) return false;
    } else if (f.playerName) {
      if (!(cell.uid > 0 && cell.n && cell.n.toLowerCase().includes(f.playerName))) return false;
    }

    if (f.baseTypes.size) {
      const baseMatch =
        (f.baseTypes.has("main")        && cell.b === MR2.cellTypes.HOMECELL) ||
        (f.baseTypes.has("outpost")     && cell.b === MR2.cellTypes.OUTPOST)  ||
        (f.baseTypes.has("wildmonster") && cell.b === MR2.cellTypes.WM);
      if (!baseMatch) return false;
    }

    if (f.terrainTypes.size) {
      const terrainMatch =
        (f.terrainTypes.has("water") && i <= 99)             ||
        (f.terrainTypes.has("sand")  && i > 99  && i <= 110) ||
        (f.terrainTypes.has("grass") && i > 110 && i <= 170) ||
        (f.terrainTypes.has("rock")  && i > 170);
      if (!terrainMatch) return false;
    }

    // Bonus ranges only meaningful for outposts on land.
    if (f.towerBonusRange || f.resourceBonusRange) {
      if (cell.b !== MR2.cellTypes.OUTPOST || i <= 99) return false;
      const ALT_AVG = 125;
      const tower   = Math.round(i * 100 / ALT_AVG - 100);
      const res     = Math.round(100 * ALT_AVG / i - 100);
      if (f.towerBonusRange    && !(tower >= f.towerBonusRange.min    && tower <= f.towerBonusRange.max))    return false;
      if (f.resourceBonusRange && !(res   >= f.resourceBonusRange.min && res   <= f.resourceBonusRange.max)) return false;
    }

    if (f.flingerLevels?.size) {
      if (cell.b !== MR2.cellTypes.OUTPOST) return false;
      const flingerLv = Number(cell.f) || 0;
      if (!f.flingerLevels.has(flingerLv)) return false;
    }

    return true;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  _scheduleRender() {
    this._rafId = requestAnimationFrame(() => {
      if (this._dirty) { this._render(); this._dirty = false; }
      this._scheduleRender();
    });
  }

  _render() {
    const { ctx, zoom } = this;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0e1a24";
    ctx.fillRect(0, 0, W, H);

    const zv = new Float32Array(12);
    for (let i = 0; i < 6; i++) {
      zv[i * 2]     = HEX_VERTICES[i][0] * zoom;
      zv[i * 2 + 1] = HEX_VERTICES[i][1] * zoom;
    }

    const useRect     = zoom < RECT_ZOOM;
    const rw          = HW * zoom + 1; // +1 fills sub-pixel gaps
    const rh          = HH * zoom + 1;
    const filterActive = this._hasActiveFilter();

    const startCX = Math.max(0, Math.floor(this.viewX / CS) - 2);
    const endCX   = Math.min(MR2.mapWidth  - 1, Math.ceil((this.viewX + W / zoom) / CS) + 2);
    const startCY = Math.max(0, Math.floor(this.viewY / RS) - 1);
    const endCY   = Math.min(MR2.mapHeight - 1, Math.ceil((this.viewY + H / zoom) / RS) + 2);

    const visibleCellCount = (endCX - startCX + 1) * (endCY - startCY + 1);
    const useTexture = !!this._worldTexture && visibleCellCount > TEXTURE_CELL_THRESHOLD;

    const fillBucket = (color, pos) => {
      if (!pos.length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (useRect) {
        for (let i = 0; i < pos.length; i += 2) ctx.rect(pos[i], pos[i + 1], rw, rh);
      } else {
        for (let i = 0; i < pos.length; i += 2) {
          const sx = pos[i], sy = pos[i + 1];
          ctx.moveTo(sx + zv[0], sy + zv[1]);
          ctx.lineTo(sx + zv[2], sy + zv[3]);
          ctx.lineTo(sx + zv[4], sy + zv[5]);
          ctx.lineTo(sx + zv[6], sy + zv[7]);
          ctx.lineTo(sx + zv[8], sy + zv[9]);
          ctx.lineTo(sx + zv[10], sy + zv[11]);
          ctx.closePath();
        }
      }
      ctx.fill();
    };

    if (useTexture) {
      this._drawWorldTexture();

      if (filterActive) {
        // One flat wash dims the whole view instead of per-cell dim fills, then only
        // matching cells are redrawn on top — the texture path stays cheap either way.
        ctx.fillStyle = COL_DIM_FILL;
        ctx.fillRect(0, 0, W, H);

        const matches = this._getFilterMatchPositions();
        const fHit = [];
        for (let i = 0; i < matches.length; i += 2) {
          const cx = matches[i], cy = matches[i + 1];
          const colOff = cx % 2 !== 0 ? CO : 0;
          fHit.push((cx * CS - this.viewX) * zoom, (cy * RS + colOff - this.viewY) * zoom);
        }
        fillBucket(COL_FILTER_FILL, fHit);
      }
    } else {
      const terrain = new Map();
      const overlay = new Map();
      const fDim    = [];
      const fHit    = [];

      for (let cx = startCX; cx <= endCX; cx++) {
        const colOff = cx % 2 !== 0 ? CO : 0;
        for (let cy = startCY; cy <= endCY; cy++) {
          const cell = this.cells.get(cellKey(cx, cy));
          const sx = (cx * CS - this.viewX) * zoom;
          const sy = (cy * RS + colOff - this.viewY) * zoom;

          const fill = getTileDef(cell?.i ?? 0).fill;
          let tb = terrain.get(fill);
          if (!tb) { tb = []; terrain.set(fill, tb); }
          tb.push(sx, sy);

          if (cell && cell.b !== undefined && !isWater(cell.i ?? 0)) {
            const isHome = cell.b === MR2.cellTypes.HOMECELL;
            const oc = cell.uid === 0
              ? COL_WM_FILL
              : cell.mine === 1
                ? (isHome ? COL_MINE_HOME_FILL : COL_MINE_OUT_FILL)
                : (isHome ? COL_OTHER_HOME_FILL : COL_OTHER_OUT_FILL);
            let ob = overlay.get(oc);
            if (!ob) { ob = []; overlay.set(oc, ob); }
            ob.push(sx, sy);
          }

          if (filterActive && cell) {
            if (this._cellMatchesFilter(cell)) fHit.push(sx, sy);
            else fDim.push(sx, sy);
          }
        }
      }

      for (const [color, pos] of terrain) fillBucket(color, pos);
      for (const [color, pos] of overlay) fillBucket(color, pos);

      if (filterActive) {
        fillBucket(COL_DIM_FILL,    fDim);
        fillBucket(COL_FILTER_FILL, fHit);
      }
    }

    // Path tool's route — a stroked line, not a fill, so the hop cells' own
    // ownership colour stays visible. Ring = pending, dot = completed, red = blocked.
    if (this.route && this.route.path.length > 1) {
      const hwPx = HW * zoom, hhPx = HH * zoom;
      const centerOf = (cx, cy) => {
        const { x: wx, y: wy } = cellToWorld(cx, cy);
        return [(wx - this.viewX) * zoom + hwPx / 2, (wy - this.viewY) * zoom + hhPx / 2];
      };
      const pts = this.route.path.map((p) => centerOf(p.x, p.y));

      ctx.save();
      ctx.strokeStyle = COL_ROUTE_LINE;
      ctx.lineWidth = Math.max(1.5, hwPx * 0.03);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const markerR = Math.max(3, Math.min(9, hwPx * 0.09));
      const ringWidth = Math.max(1.5, hwPx * 0.025);
      for (let i = 0; i < pts.length; i++) {
        const [sx, sy] = pts[i];
        const isStart = i === 0;
        const isEnd = i === pts.length - 1;
        const status = this.route.hopStatus?.[i];

        ctx.beginPath();
        ctx.arc(sx, sy, markerR, 0, Math.PI * 2);
        if (isStart) {
          ctx.fillStyle = COL_ROUTE_START;
          ctx.fill();
        } else if (status === "completed") {
          ctx.fillStyle = COL_ROUTE_LINE;
          ctx.fill();
        } else if (status === "blocked") {
          ctx.strokeStyle = COL_ROUTE_BLOCKED;
          ctx.lineWidth = ringWidth;
          ctx.stroke();
        } else {
          ctx.strokeStyle = COL_ROUTE_LINE;
          ctx.lineWidth = ringWidth;
          ctx.stroke();
        }

        if (isEnd) {
          ctx.beginPath();
          ctx.arc(sx, sy, markerR * 1.8, 0, Math.PI * 2);
          ctx.strokeStyle = status === "blocked" ? COL_ROUTE_BLOCKED : COL_ROUTE_LINE;
          ctx.lineWidth = Math.max(1, hwPx * 0.018);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (this.hoveredCell) {
      const { x: cx, y: cy } = this.hoveredCell;
      const { x: wx, y: wy } = cellToWorld(cx, cy);
      hexPath(ctx, (wx - this.viewX) * zoom, (wy - this.viewY) * zoom, zoom);
      ctx.fillStyle = COL_HOVER_FILL;
      ctx.fill();
    }

    if (this.selectedCell) {
      const { x: cx, y: cy } = this.selectedCell;
      const { x: wx, y: wy } = cellToWorld(cx, cy);
      const sx = (wx - this.viewX) * zoom;
      const sy = (wy - this.viewY) * zoom;
      hexPath(ctx, sx, sy, zoom);
      ctx.fillStyle = COL_SELECTED_FL;
      ctx.fill();
      ctx.strokeStyle = COL_SELECTED_ST;
      ctx.lineWidth = Math.max(1, zoom * 1.5);
      ctx.stroke();
    }

    if (!useTexture && zoom >= GRID_ZOOM) {
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      for (let cx = startCX; cx <= endCX; cx++) {
        const colOff = cx % 2 !== 0 ? CO : 0;
        for (let cy = startCY; cy <= endCY; cy++) {
          const sx = (cx * CS - this.viewX) * zoom;
          const sy = (cy * RS + colOff - this.viewY) * zoom;
          ctx.moveTo(sx + zv[0], sy + zv[1]);
          ctx.lineTo(sx + zv[2], sy + zv[3]);
          ctx.lineTo(sx + zv[4], sy + zv[5]);
          ctx.lineTo(sx + zv[6], sy + zv[7]);
          ctx.lineTo(sx + zv[8], sy + zv[9]);
          ctx.lineTo(sx + zv[10], sy + zv[11]);
          ctx.closePath();
        }
      }
      ctx.stroke();
    }

    if (!useTexture && zoom >= LABEL_ZOOM) {
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin     = "round";
      const hwPx = HW * zoom;
      const hhPx = HH * zoom;

      for (let cx = startCX; cx <= endCX; cx++) {
        const colOff = cx % 2 !== 0 ? CO : 0;
        for (let cy = startCY; cy <= endCY; cy++) {
          const cell = this.cells.get(cellKey(cx, cy));
          if (!cell || isWater(cell.i ?? 0) || !cell.n) continue;
          const sx = (cx * CS - this.viewX) * zoom + hwPx / 2;
          const sy = (cy * RS + colOff - this.viewY) * zoom + hhPx / 2;
          const isHomeLabel = cell.b === MR2.cellTypes.HOMECELL;

          const nameColor = cell.uid === 0
            ? "rgba(255,255,255,0.70)"
            : cell.mine === 1
              ? (isHomeLabel ? "#ffffff"  : "#cceeff")
              : (isHomeLabel ? "#ffffff"  : "#fff0cc");

          if (zoom >= LABEL_FULL_ZOOM) {
            ctx.font      = `bold ${Math.min(hhPx * 0.22, 12)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.88)";
            ctx.strokeText(cell.n.substring(0, 12), sx, sy - hhPx * 0.1);
            ctx.fillStyle = nameColor;
            ctx.fillText(cell.n.substring(0, 12),   sx, sy - hhPx * 0.1);
            ctx.font      = `${Math.min(hhPx * 0.18, 10)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 2;
            ctx.strokeText(`Lv ${cell.l ?? "?"}`, sx, sy + hhPx * 0.15);
            ctx.fillStyle = "rgba(255,255,255,0.82)";
            ctx.fillText(`Lv ${cell.l ?? "?"}`,   sx, sy + hhPx * 0.15);
          } else {
            ctx.font      = `bold ${Math.min(hhPx * 0.22, 11)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 2;
            ctx.strokeStyle = "rgba(0,0,0,0.88)";
            ctx.strokeText(cell.n.substring(0, 8), sx, sy - hhPx * 0.1);
            ctx.fillStyle = nameColor;
            ctx.fillText(cell.n.substring(0, 8),   sx, sy - hhPx * 0.1);
            ctx.font      = `${Math.min(hhPx * 0.18, 9)}px "Trebuchet MS", sans-serif`;
            ctx.strokeText(`Lv ${cell.l ?? "?"}`, sx, sy + hhPx * 0.15);
            ctx.fillStyle = "rgba(255,255,255,0.82)";
            ctx.fillText(`Lv ${cell.l ?? "?"}`,   sx, sy + hhPx * 0.15);
          }
        }
      }
    }

    ctx.strokeStyle = "rgba(100,160,255,0.40)";
    ctx.lineWidth   = 2;
    ctx.strokeRect(
      -this.viewX * zoom,
      -this.viewY * zoom,
      (MR2.mapWidth  * CS + HW / 4) * zoom,
      (MR2.mapHeight * RS + CO)     * zoom,
    );
  }

  // ─── Coordinate helpers ───────────────────────────────────────────────────

  _screenToCell(sx, sy) {
    return worldToCell(sx / this.zoom + this.viewX, sy / this.zoom + this.viewY);
  }

  _clampView() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const mapW = MR2.mapWidth  * CS + HW / 4;
    const mapH = MR2.mapHeight * RS + CO;
    const m = 0.2;
    this.viewX = Math.max(-(W / this.zoom) * m, Math.min(this.viewX, mapW + (W / this.zoom) * m - W / this.zoom));
    this.viewY = Math.max(-(H / this.zoom) * m, Math.min(this.viewY, mapH + (H / this.zoom) * m - H / this.zoom));
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  _bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.setZoom(this.zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP),
                   e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      this._dragging  = true;
      this._hasDragged = false;
      const rect = canvas.getBoundingClientRect();
      this._dragStartX = e.clientX - rect.left;
      this._dragStartY = e.clientY - rect.top;
      this._dragViewX  = this.viewX;
      this._dragViewY  = this.viewY;
      canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

      if (this._dragging) {
        const dx = sx - this._dragStartX, dy = sy - this._dragStartY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._hasDragged = true;
        this.viewX = this._dragViewX - dx / this.zoom;
        this.viewY = this._dragViewY - dy / this.zoom;
        this._clampView();
        this.markDirty();
        this._scheduleViewportChange();
      } else {
        const coord = this._screenToCell(sx, sy);
        if (this.onCoordsChange) this.onCoordsChange(coord?.x ?? null, coord?.y ?? null);
        if (coord) {
          const cell = this.cells.get(cellKey(coord.x, coord.y)) ?? { x: coord.x, y: coord.y };
          if (!this.hoveredCell || this.hoveredCell.x !== coord.x || this.hoveredCell.y !== coord.y) {
            this.hoveredCell = cell;
            this.markDirty();
            if (this.onCellHover) this.onCellHover(cell);
          }
        } else if (this.hoveredCell) {
          this.hoveredCell = null;
          this.markDirty();
          if (this.onCellHover) this.onCellHover(null);
        }
      }
    });

    canvas.addEventListener("pointerup", (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      canvas.style.cursor = "crosshair";
      if (!this._hasDragged) {
        const rect = canvas.getBoundingClientRect();
        const coord = this._screenToCell(e.clientX - rect.left, e.clientY - rect.top);
        if (coord) {
          const cell = this.cells.get(cellKey(coord.x, coord.y)) ?? { x: coord.x, y: coord.y };
          this.selectedCell = cell;
          this.markDirty();
          if (this.onCellClick) this.onCellClick(cell);
        } else {
          this.selectedCell = null;
          this.markDirty();
          if (this.onCellClick) this.onCellClick(null);
        }
      }
    });

    canvas.addEventListener("pointerleave", () => {
      if (this.hoveredCell) { this.hoveredCell = null; this.markDirty(); if (this.onCellHover) this.onCellHover(null); }
      if (this._dragging)   { this._dragging = false; canvas.style.cursor = "crosshair"; }
    });

    let _td = null;
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2)
        _td = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && _td !== null) {
        e.preventDefault();
        const d    = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const rect = canvas.getBoundingClientRect();
        this.setZoom(this.zoom * (d / _td),
                     (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
                     (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top);
        _td = d;
      }
    }, { passive: false });
    canvas.addEventListener("touchend", () => { _td = null; });

    canvas.style.cursor = "crosshair";
  }
}
