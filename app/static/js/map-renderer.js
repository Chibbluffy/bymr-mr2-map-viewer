import { MR2, HEX_VERTICES, cellKey, getTileDef, isWater, tribeAt, levelAt, generateBaseId } from "./shared.js";
import { wrappedHexDistance } from "./route.js";

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
// Occupied-cell colors mostly follow the original game client's own alliance-
// relationship system (com/monsters/alliances/AllyInfo.as's playerHex/allyHex/
// friendlyHex/hostileHex/neutralHex/noneHex), so a base here is colored the same
// as it would be in-game for whoever "View As" is set to. See _relationshipTier().
// Exception: "self" — the game's own playerHex (0x3887e7, a flat medium blue) got
// lost next to allyHex's pale blue and the water's dark navy on a map with this
// much blue already. A plain hue swap to cyan wasn't enough on its own either —
// blended at the same alpha as every other tier, the terrain underneath still
// showed through and desaturated it into a muted teal — so self is pure cyan
// *and* gets its own near-opaque alpha below, instead of sharing REL_ALPHA_*.
const REL_RGB = {
  self:     [0, 255, 255],   // was playerHex 0x3887e7 — pure cyan, see above
  ally:     [172, 215, 249], // allyHex     0xacd7f9 — fellow member of the viewer's alliance
  friendly: [19, 221, 5],    // friendlyHex 0x13dd05 — an alliance the viewer's alliance has befriended
  hostile:  [255, 70, 40],   // hostileHex  0xff4628 — an alliance the viewer's alliance has declared an enemy
  neutral:  [255, 255, 0],   // neutralHex  0xffff00 — any other alliance with no declared relation (or no viewer identity at all)
  none:     [255, 255, 255], // noneHex     0xffffff — not in any alliance
};
const REL_ALPHA_HOME = 0.90;
const REL_ALPHA_OUT  = 0.55;
const SELF_ALPHA_HOME = 0.98; // self's own, much-closer-to-opaque alpha — see the comment above
const SELF_ALPHA_OUT  = 0.90;

function relAlpha(tier, isHome) {
  if (tier === "self") return isHome ? SELF_ALPHA_HOME : SELF_ALPHA_OUT;
  return isHome ? REL_ALPHA_HOME : REL_ALPHA_OUT;
}

// ctx fillStyle strings, built once from REL_RGB so the canvas-path and texture-path
// colors can never drift out of sync with each other.
const REL_FILL = {};
for (const tier of Object.keys(REL_RGB)) {
  const [r, g, b] = REL_RGB[tier];
  REL_FILL[tier] = {
    home: `rgba(${r},${g},${b},${relAlpha(tier, true)})`,
    out:  `rgba(${r},${g},${b},${relAlpha(tier, false)})`,
  };
}

const COL_WM_FILL = "rgba(200,200,200,0.35)";

const COL_HOVER_FILL  = "rgba(255,255,255,0.20)";
const COL_SELECTED_ST = "rgba(255,210,0,0.92)";
const COL_SELECTED_FL = "rgba(255,210,0,0.30)";
const COL_FILTER_FILL = "rgba(255,50,200,0.72)";
const COL_DIM_FILL    = "rgba(0,0,0,0.38)";

// Purple so it reads as its own thing against the relationship colors above — green
// and red are both already taken (friendly alliance / hostile alliance).
const COL_ROUTE_LINE    = "#a855f7";
const COL_ROUTE_START   = "#ffffff";
// Same red as REL_RGB.hostile — a blocked hop is "someone else's now", the same
// situation a hostile-alliance base is in, so it reuses that meaning rather than
// inventing a second, slightly-different red.
const COL_ROUTE_BLOCKED = "#ff4628";

const COL_MEASURE_LINE      = "#ffd84a";
const COL_MEASURE_SELECTED  = "#ffffff";
const COL_MEASURE_DELETE    = "#ff4444";

// A click/tap this close (screen px) to an existing measurement's line counts as hitting
// it, and this close to its delete badge counts as hitting that instead.
const MEASURE_HIT_PX    = 8;
const MEASURE_BADGE_PX  = 10;

// Numeric RGB equivalents of the terrain/WM colors above, for
// _rebuildWorldTexture()'s per-pixel ImageData writes (occupant colors reuse
// REL_RGB directly, so those can't drift out of sync the way these used to).
const RGB_WATER = [15, 28, 96];
const RGB_LAND  = [40, 32, 26];
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
    this._allianceData = null;      // see setAllianceData()
    this._viewerAllianceId = null;  // see setViewerAllianceId()
    this._avatarCache = new Map();  // avatar URL -> {img, ready, failed} — see _getAvatarImage()
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

    // ── Measuring tool — not saved anywhere; gone on refresh by design ────────
    this.measureMode  = false;
    this.measurements = []; // [{ id, start: {x,y}, end: {x,y} }]
    this._measureIdSeq = 1;
    this._measureDownCell   = null; // cell under the pointer at measure-mode pointerdown
    this._measureDownScreen = null; // {sx, sy} at that same pointerdown, for drag-vs-click
    this._measureDragging   = false;
    this._measurePendingStart = null; // cell from a first "click" awaiting its second click
    this._measurePreviewEnd   = null; // live cell under pointer while click-dragging a ruler
    this._selectedMeasurementId = null;

    this._dirty = true;
    this._rafId = null;
    this._viewportChangeTimer = null;

    this.onCellHover      = null;
    this.onCellClick      = null;
    this.onCoordsChange   = null;
    this.onViewportChanged = null; // fires ~250ms after a pan/zoom
    this.onMeasurementsChanged = null; // fires whenever this.measurements changes

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
          } else {
            const tier = this._relationshipTier(cell);
            rgb = blendRGB(rgb, REL_RGB[tier], relAlpha(tier, isHome));
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
    return this.myUserId != null ? this.getHomeCellForUid(this.myUserId) : null;
  }

  /** Any player's home cell, not just "mine" — powers the detail panel's "Go to Home" link. */
  getHomeCellForUid(uid) {
    for (const cell of this.cells.values()) {
      if (cell.uid === uid && cell.b === MR2.cellTypes.HOMECELL) return cell;
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

  /** Changes which uid renders as "mine" (View As) — rebuilds the low-zoom
   * texture too, since that's a cached pixel buffer baked from the old identity. */
  setMyUserId(uid) {
    if (this.myUserId === uid) return;
    this.myUserId = uid;
    if (this._worldTexture) this._rebuildWorldTexture();
    this.markDirty();
  }

  // ─── Alliance-relationship coloring ────────────────────────────────────────
  // See REL_RGB/REL_FILL up top and _relationshipTier() below for the actual
  // color logic — this is just the data these are computed against.

  /** data: { uidToAllianceId: Map<uid, allianceId>, alliancesById: Map<allianceId, {name, relationships}> } | null */
  setAllianceData(data) {
    this._allianceData = data;
    if (this._worldTexture) this._rebuildWorldTexture();
    this.markDirty();
  }

  /** The "View As" player's own alliance id, or null (no identity, or no alliance). */
  setViewerAllianceId(allianceId) {
    if (this._viewerAllianceId === allianceId) return;
    this._viewerAllianceId = allianceId;
    if (this._worldTexture) this._rebuildWorldTexture();
    this.markDirty();
  }

  /**
   * Which of REL_RGB's six buckets an occupied cell falls into, mirroring the
   * original client's AllyInfo.Relations() + MapRoomCell.SetupAlliance(): your
   * own bases always win regardless of alliance, a no-alliance player is always
   * "none", and with no alliance of your own to compare against (no View As, or
   * View As a player with no alliance) everyone else just reads as "neutral" —
   * same as the real client's `!ALLIANCES._myAlliance` early-out.
   */
  _relationshipTier(cell) {
    if (this.myUserId != null && cell.uid === this.myUserId) return "self";
    const allianceId = this._allianceData?.uidToAllianceId?.get(cell.uid);
    if (!allianceId) return "none";
    if (this._viewerAllianceId != null) {
      if (allianceId === this._viewerAllianceId) return "ally";
      const rel = this._allianceData?.alliancesById?.get(this._viewerAllianceId)?.relationships?.[allianceId];
      if (rel === -1) return "hostile";
      if (rel === 1) return "friendly";
    }
    return "neutral";
  }

  /**
   * Returns a loaded, ready-to-draw avatar image for `url`, or null if there's
   * none, it's still loading, or it failed — any of which just means the caller
   * falls back to whatever's already drawn underneath (the flat hex fill).
   * Loads lazily and caches by URL for the renderer's lifetime; markDirty() on
   * load is what makes the avatar pop in on the next frame once it's ready.
   */
  _getAvatarImage(url) {
    if (!url) return null;
    let entry = this._avatarCache.get(url);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false, failed: false };
      img.onload  = () => { entry.ready = true; this.markDirty(); };
      img.onerror = () => { entry.failed = true; };
      img.src = url;
      this._avatarCache.set(url, entry);
    }
    return entry.ready && !entry.failed ? entry.img : null;
  }

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
    // hasFinalApproach's last path entry (e.g. a main yard) is never actually
    // captured, so it doesn't count as a real hop here — see route.js's reconstruct().
    const realLength = this.route.hasFinalApproach ? this.route.path.length - 1 : this.route.path.length;
    const counts = { completed: 0, blocked: 0, pending: 0, total: realLength - 1 };
    for (let i = 1; i < realLength; i++) {
      const status = this.route.hopStatus?.[i];
      if (status === "completed") counts.completed++;
      else if (status === "blocked") counts.blocked++;
      else counts.pending++;
    }
    return counts;
  }

  // ─── Measuring tool ─────────────────────────────────────────────────────────
  // In-memory only — never persisted, so a refresh clears every ruler. See
  // _bindEvents() for the click/drag-to-measure interaction and _render() for the
  // line/label/delete-badge drawing.

  /** Turning it off also drops any in-progress pick and deselects — but keeps existing rulers. */
  setMeasureMode(on) {
    this.measureMode = !!on;
    this._measurePendingStart = null;
    this._measureDragging = false;
    this._measureDownCell = null;
    this._selectedMeasurementId = null;
    this.markDirty();
  }

  addMeasurement(start, end) {
    this.measurements.push({ id: this._measureIdSeq++, start, end });
    this.onMeasurementsChanged?.();
    this.markDirty();
  }

  removeMeasurement(id) {
    const before = this.measurements.length;
    this.measurements = this.measurements.filter((m) => m.id !== id);
    if (this.measurements.length === before) return;
    if (this._selectedMeasurementId === id) this._selectedMeasurementId = null;
    this.onMeasurementsChanged?.();
    this.markDirty();
  }

  clearMeasurements() {
    if (!this.measurements.length) return;
    this.measurements = [];
    this._selectedMeasurementId = null;
    this.onMeasurementsChanged?.();
    this.markDirty();
  }

  _cellCenterScreen(cx, cy) {
    const { x: wx, y: wy } = cellToWorld(cx, cy);
    return [
      (wx - this.viewX) * this.zoom + (HW * this.zoom) / 2,
      (wy - this.viewY) * this.zoom + (HH * this.zoom) / 2,
    ];
  }

  _distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** Measurement nearest (sx, sy) within MEASURE_HIT_PX, or null. */
  _hitTestMeasurements(sx, sy) {
    let best = null, bestDist = MEASURE_HIT_PX;
    for (const m of this.measurements) {
      const [ax, ay] = this._cellCenterScreen(m.start.x, m.start.y);
      const [bx, by] = this._cellCenterScreen(m.end.x, m.end.y);
      const d = this._distToSegment(sx, sy, ax, ay, bx, by);
      if (d <= bestDist) { best = m; bestDist = d; }
    }
    return best;
  }

  /** True if (sx, sy) hits the delete badge of the currently-selected measurement. */
  _hitTestMeasureDeleteBadge(sx, sy) {
    if (this._selectedMeasurementId == null) return false;
    const m = this.measurements.find((mm) => mm.id === this._selectedMeasurementId);
    if (!m) return false;
    const [ax, ay] = this._cellCenterScreen(m.start.x, m.start.y);
    const [bx, by] = this._cellCenterScreen(m.end.x, m.end.y);
    const midX = (ax + bx) / 2, midY = (ay + by) / 2;
    return Math.hypot(sx - midX, sy - midY - MEASURE_BADGE_PX * 2) <= MEASURE_BADGE_PX;
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
    let total = 0;
    for (const positions of this._getFilterMatchBuckets().values()) total += positions.length / 2;
    return total;
  }

  // Flat [x, y, x, y, ...] world-cell coords of every filter match, bucketed by resolved
  // color (see _filterColorForCell()) and cached by (filter, cellsVersion) so a drag/zoom
  // while zoomed way out doesn't re-scan all 640k cells every frame — only the
  // texture-blit render path (extreme zoom-out) uses this.
  _getFilterMatchBuckets() {
    const cache = this._filterMatchCache;
    if (cache && cache.filter === this.filter && cache.cellsVersion === this._cellsVersion) {
      return cache.buckets;
    }
    const buckets = new Map();
    for (const cell of this.cells.values()) {
      if (!this._cellMatchesFilter(cell)) continue;
      const color = this._filterColorForCell(cell);
      let bucket = buckets.get(color);
      if (!bucket) { bucket = []; buckets.set(color, bucket); }
      bucket.push(cell.x, cell.y);
    }
    this._filterMatchCache = { filter: this.filter, cellsVersion: this._cellsVersion, buckets };
    return buckets;
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

  // Resolves the highlight color for a cell that already matched the active filter —
  // a per-player color when the filter carries one for that uid, else the default.
  _filterColorForCell(cell) {
    return this.filter?.filterPlayerColors?.get(cell.uid) || COL_FILTER_FILL;
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

        for (const [color, matches] of this._getFilterMatchBuckets()) {
          const fHit = [];
          for (let i = 0; i < matches.length; i += 2) {
            const cx = matches[i], cy = matches[i + 1];
            const colOff = cx % 2 !== 0 ? CO : 0;
            fHit.push((cx * CS - this.viewX) * zoom, (cy * RS + colOff - this.viewY) * zoom);
          }
          fillBucket(color, fHit);
        }
      }
    } else {
      const terrain = new Map();
      const overlay = new Map();
      const fDim    = [];
      const fHit    = new Map(); // color -> flat [x,y,...] screen positions, per filterPlayerColors

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
              : REL_FILL[this._relationshipTier(cell)][isHome ? "home" : "out"];
            let ob = overlay.get(oc);
            if (!ob) { ob = []; overlay.set(oc, ob); }
            ob.push(sx, sy);
          }

          if (filterActive && cell) {
            if (this._cellMatchesFilter(cell)) {
              const color = this._filterColorForCell(cell);
              let bucket = fHit.get(color);
              if (!bucket) { bucket = []; fHit.set(color, bucket); }
              bucket.push(sx, sy);
            } else {
              fDim.push(sx, sy);
            }
          }
        }
      }

      for (const [color, pos] of terrain) fillBucket(color, pos);
      for (const [color, pos] of overlay) fillBucket(color, pos);

      if (filterActive) {
        fillBucket(COL_DIM_FILL, fDim);
        for (const [color, pos] of fHit) fillBucket(color, pos);
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

    // ─── Measuring tool overlay ─────────────────────────────────────────────
    if (this.measurements.length || this._measurePendingStart ||
        (this.measureMode && this._measureDownCell && this._measurePreviewEnd)) {
      const drawRuler = (startCell, endCell, { selected = false, preview = false } = {}) => {
        const [ax, ay] = this._cellCenterScreen(startCell.x, startCell.y);
        const [bx, by] = this._cellCenterScreen(endCell.x, endCell.y);
        const dist = wrappedHexDistance(startCell.x, startCell.y, endCell.x, endCell.y).distance;
        const lineColor = selected ? COL_MEASURE_SELECTED : COL_MEASURE_LINE;

        ctx.save();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth   = selected ? 2.5 : 2;
        ctx.lineCap     = "round";
        ctx.globalAlpha = preview ? 0.7 : 1;
        if (preview) ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);

        for (const [px, py] of [[ax, ay], [bx, by]]) {
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fillStyle = lineColor;
          ctx.fill();
        }

        const midX = (ax + bx) / 2, midY = (ay + by) / 2;
        const label = `${dist} ${dist === 1 ? "hex" : "hexes"}`;
        ctx.font = `bold 12px "Trebuchet MS", sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth    = 3;
        ctx.strokeStyle  = "rgba(0,0,0,0.85)";
        ctx.strokeText(label, midX, midY);
        ctx.fillStyle = lineColor;
        ctx.fillText(label, midX, midY);
        ctx.restore();

        if (selected) {
          const badgeY = midY + MEASURE_BADGE_PX * 2;
          ctx.beginPath();
          ctx.arc(midX, badgeY, MEASURE_BADGE_PX, 0, Math.PI * 2);
          ctx.fillStyle = COL_MEASURE_DELETE;
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth   = 1.6;
          ctx.lineCap     = "round";
          const r = MEASURE_BADGE_PX * 0.45;
          ctx.beginPath();
          ctx.moveTo(midX - r, badgeY - r); ctx.lineTo(midX + r, badgeY + r);
          ctx.moveTo(midX + r, badgeY - r); ctx.lineTo(midX - r, badgeY + r);
          ctx.stroke();
        }
      };

      for (const m of this.measurements) {
        drawRuler(m.start, m.end, { selected: m.id === this._selectedMeasurementId });
      }

      if (this._measurePendingStart) {
        const [px, py] = this._cellCenterScreen(this._measurePendingStart.x, this._measurePendingStart.y);
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.strokeStyle = COL_MEASURE_LINE;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (this.measureMode && this._measureDownCell && this._measurePreviewEnd) {
        drawRuler(this._measureDownCell, this._measurePreviewEnd, { preview: true });
      }
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

    // ─── Home-base avatar markers ───────────────────────────────────────────
    // The avatar fills the hex itself (clipped to its exact outline, cover-fit,
    // ringed in the relationship color) rather than sitting in a smaller circle
    // inset inside it. Shown across the whole "hexes are still hexes" zoom range
    // (!useRect) rather than waiting for LABEL_ZOOM like name/level text does — a
    // filled hex still reads as *something* well below the size text needs. Below
    // RECT_ZOOM hexes degrade to plain filled rects and there's nothing worth
    // drawing on top.
    if (!useTexture && !useRect && !this._dragging) {
      const hwPx = HW * zoom, hhPx = HH * zoom;
      const ringWidth = Math.max(1.5, Math.min(hwPx, hhPx) * 0.055);

      for (let cx = startCX; cx <= endCX; cx++) {
        const colOff = cx % 2 !== 0 ? CO : 0;
        for (let cy = startCY; cy <= endCY; cy++) {
          const cell = this.cells.get(cellKey(cx, cy));
          if (!cell || cell.b !== MR2.cellTypes.HOMECELL || !(cell.uid > 0)) continue;
          const img = this._getAvatarImage(cell.pic_square || cell.im);
          if (!img) continue; // no avatar, still loading, or failed — the flat hex fill underneath already covers it

          const originSX = (cx * CS - this.viewX) * zoom;
          const originSY = (cy * RS + colOff - this.viewY) * zoom;
          const sx = originSX + hwPx / 2;
          const sy = originSY + hhPx / 2;
          const [r, g, b] = REL_RGB[this._relationshipTier(cell)];

          // The hex itself is the frame — clip to its exact outline (not a circle
          // inset inside it) and cover-fit the avatar into that same hex-shaped area,
          // cropping whichever axis overflows rather than squishing the image.
          const imgW = img.naturalWidth || img.width || 1;
          const imgH = img.naturalHeight || img.height || 1;
          const coverScale = Math.max(hwPx / imgW, hhPx / imgH);
          const drawW = imgW * coverScale;
          const drawH = imgH * coverScale;

          ctx.save();
          hexPath(ctx, originSX, originSY, zoom);
          ctx.clip();
          ctx.drawImage(img, sx - drawW / 2, sy - drawH / 2, drawW, drawH);
          ctx.restore();

          hexPath(ctx, originSX, originSY, zoom);
          ctx.strokeStyle = `rgb(${r},${g},${b})`;
          ctx.lineWidth = ringWidth;
          ctx.stroke();
        }
      }
    }

    // Grid lines and name/level labels are the expensive part of this path (text layout
    // especially) — skipped while actively dragging so panning stays smooth, and redrawn
    // at full fidelity the instant the drag ends (see the pointerup/pointerleave handlers).
    if (!useTexture && zoom >= GRID_ZOOM && !this._dragging) {
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

    if (!useTexture && zoom >= LABEL_ZOOM && !this._dragging) {
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
            : cell.uid === this.myUserId
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

      if (this.measureMode) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        this._measureDownCell   = this._screenToCell(sx, sy);
        this._measureDownScreen = { sx, sy };
        this._measureDragging   = false;
        return;
      }

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

      if (this.measureMode && this._measureDownCell) {
        const dx = sx - this._measureDownScreen.sx, dy = sy - this._measureDownScreen.sy;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._measureDragging = true;
        this._measurePreviewEnd = this._screenToCell(sx, sy);
        this.markDirty();
        return;
      }

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
      if (this.measureMode) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const downCell = this._measureDownCell;
        const wasDragging = this._measureDragging;
        this._measureDownCell   = null;
        this._measureDownScreen = null;
        this._measureDragging   = false;
        this._measurePreviewEnd = null;

        if (downCell && wasDragging) {
          // Click-and-drag: start = pointerdown cell, end = pointerup cell.
          const endCoord = this._screenToCell(sx, sy);
          if (endCoord && (endCoord.x !== downCell.x || endCoord.y !== downCell.y)) {
            this.addMeasurement(downCell, endCoord);
          }
          this._selectedMeasurementId = null;
          this.markDirty();
          return;
        }

        // A plain click (no real drag): hitting the selected measurement's delete badge
        // or an existing line takes priority over the click/click two-point flow below.
        if (this._hitTestMeasureDeleteBadge(sx, sy)) {
          this.removeMeasurement(this._selectedMeasurementId);
          return;
        }
        const hit = this._hitTestMeasurements(sx, sy);
        if (hit) {
          this._selectedMeasurementId = hit.id;
          this.markDirty();
          return;
        }
        this._selectedMeasurementId = null;

        const coord = downCell ?? this._screenToCell(sx, sy);
        if (coord) {
          if (this._measurePendingStart) {
            if (coord.x !== this._measurePendingStart.x || coord.y !== this._measurePendingStart.y) {
              this.addMeasurement(this._measurePendingStart, coord);
            }
            this._measurePendingStart = null;
          } else {
            this._measurePendingStart = coord;
          }
        }
        this.markDirty();
        return;
      }

      if (!this._dragging) return;
      this._dragging = false;
      canvas.style.cursor = "crosshair";
      // The last few frames of the drag skipped grid/labels (see _render()) — one more
      // render restores them now that the drag is over.
      this.markDirty();
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
      if (this._dragging)   { this._dragging = false; canvas.style.cursor = "crosshair"; this.markDirty(); }
      if (this._measureDownCell) {
        this._measureDownCell   = null;
        this._measureDownScreen = null;
        this._measureDragging   = false;
        this._measurePreviewEnd = null;
        this.markDirty();
      }
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
