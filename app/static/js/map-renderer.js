import { MR2, HEX_VERTICES, cellKey, getTileDef, isWater } from "./shared.js";

// ─── Geometry constants ───────────────────────────────────────────────────────
// Flat-top hex grid: offset columns (odd columns shift down by half hex height).
const HW  = MR2.hexWidth;      // 104 — full drawn width
const HH  = MR2.hexHeight;     // 68  — full drawn height
const CS  = MR2.hexColStep;    // 78  — horizontal centre-to-centre (HW * 3/4)
const RS  = MR2.hexRowStep;    // 68  — vertical   centre-to-centre (= HH)
const CO  = MR2.hexColOffset;  // 34  — odd-column downward shift  (HH / 2)

const MIN_ZOOM    = 0.008;
const MAX_ZOOM    = 12;
const ZOOM_STEP   = 1.2;
const LABEL_ZOOM  = 0.8;
const LABEL_FULL_ZOOM = 1.4;
const GRID_ZOOM   = 0.15;  // below this, skip grid lines

// Below this zoom hexes are < 8 px wide; fillRect is faster and looks identical.
const RECT_ZOOM = 0.08;

// ─── Cell overlay colour palette ─────────────────────────────────────────────
// Five distinct hue families so colours stay distinguishable even under the
// COL_DIM_FILL overlay.  Hue families reserved for future states are noted
// below so expansion doesn't require a full palette rethink.
//
//  CYAN    — mine (home + outpost)
//  YELLOW  — neutral other players' home bases
//  ORANGE  — neutral other players' outposts
//  GRAY    — wild monster tribes
//  MAGENTA — filter match highlight
//
//  Reserved for future relationship colours:
//    GREEN  — alliance members (home + outpost)
//    PURPLE — truced players   (home + outpost)

const COL_MINE              = "#00e8ff";
const COL_MINE_HOME_FILL    = "rgba(0,232,255,0.88)";    // mine  — home   — vivid cyan
const COL_MINE_OUT_FILL     = "rgba(0,170,230,0.50)";    // mine  — post   — softer blue-cyan
const COL_OTHER_HOME_FILL   = "rgba(255,210,30,0.90)";   // other — home   — golden yellow
const COL_OTHER_OUT_FILL    = "rgba(255,130,0,0.55)";    // other — post   — orange
const COL_WM_FILL           = "rgba(200,200,200,0.35)";  // wild tribe     — light gray tint

// Future: alliance home/outpost → green; truce home/outpost → purple
// const COL_ALLY_HOME_FILL  = "rgba(40,210,100,0.88)";
// const COL_ALLY_OUT_FILL   = "rgba(40,180,80,0.50)";
// const COL_TRUCE_HOME_FILL = "rgba(180,80,255,0.82)";
// const COL_TRUCE_OUT_FILL  = "rgba(160,60,220,0.48)";

const COL_HOVER_FILL  = "rgba(255,255,255,0.20)";
const COL_SELECTED_ST = "rgba(255,210,0,0.92)";
const COL_SELECTED_FL = "rgba(255,210,0,0.30)";
// Filter highlight — magenta; distinct from all current and planned hue families
const COL_FILTER_FILL = "rgba(255,50,200,0.72)";
const COL_DIM_FILL    = "rgba(0,0,0,0.38)";

// ─── Hex helpers ─────────────────────────────────────────────────────────────

// Flat-top column-offset grid: odd columns shift down by CO.
function cellToWorld(cx, cy) {
  return {
    x: cx * CS,
    y: cy * RS + (cx % 2 !== 0 ? CO : 0),
  };
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

// Single-hex path (used for hover / selected where we need clip or stroke).
function hexPath(ctx, sx, sy, zoom) {
  ctx.beginPath();
  for (let i = 0; i < HEX_VERTICES.length; i++) {
    const px = sx + HEX_VERTICES[i][0] * zoom;
    const py = sy + HEX_VERTICES[i][1] * zoom;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ─── MapRenderer ──────────────────────────────────────────────────────────────

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");

    this.cells   = new Map();
    this.zoom    = 0.25;
    this.viewX   = (MR2.mapWidth  * CS) / 2 - canvas.clientWidth  / (2 * this.zoom);
    this.viewY   = (MR2.mapHeight * RS + CO) / 2 - canvas.clientHeight / (2 * this.zoom);

    this.hoveredCell  = null;
    this.selectedCell = null;
    this.filter       = null;

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
    this.onViewportChanged = null;  // fires ~250ms after any pan/zoom

    this._bindEvents();
    this._scheduleRender();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  ingestArea(areaData) {
    for (const [xStr, row] of Object.entries(areaData)) {
      const cx = parseInt(xStr, 10);
      for (const [yStr, data] of Object.entries(row)) {
        const cy = parseInt(yStr, 10);
        if (cx < 0 || cx >= MR2.mapWidth || cy < 0 || cy >= MR2.mapHeight) continue;
        this.cells.set(cellKey(cx, cy), Object.assign({}, data, { x: cx, y: cy }));
      }
    }
    this.markDirty();
  }

  // Ingest a flat array of { x, y, ...fields } returned by /worldmapv2/getcellsforviewer.
  ingestCells(celldata) {
    for (const cell of celldata) {
      if (cell.x < 0 || cell.x >= MR2.mapWidth || cell.y < 0 || cell.y >= MR2.mapHeight) continue;
      this.cells.set(cellKey(cell.x, cell.y), cell);
    }
    this.markDirty();
  }

  clearCells() {
    this.cells.clear();
    this.hoveredCell = null;
    this.selectedCell = null;
    this.markDirty();
  }

  centerOn(cx, cy) {
    const { x, y } = cellToWorld(cx, cy);
    this.viewX = x + HW / 2 - this.canvas.clientWidth  / (2 * this.zoom);
    this.viewY = y + HH / 2 - this.canvas.clientHeight / (2 * this.zoom);
    this._clampView();
    this.markDirty();
    // Don't fire onViewportChanged here — centering is an intentional jump,
    // not a user pan, and demand-loading is handled by the caller.
  }

  setZoom(newZoom, pivotSX, pivotSY) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
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
    this._clampView();
    this.markDirty();
  }

  findHomeCell() {
    for (const cell of this.cells.values()) {
      if (cell.mine === 1 && cell.b === MR2.cellTypes.HOMECELL) return cell;
    }
    return null;
  }

  // Returns a Set of "x,y" chunk-origin strings (multiples of 10) that are
  // currently visible on screen, plus an optional buffer ring of extra chunks.
  getVisibleChunkKeys(buffer = 2) {
    const W    = this.canvas.clientWidth;
    const H    = this.canvas.clientHeight;
    const step = 10;

    const startCX = Math.max(0, Math.floor(this.viewX / CS) - 2);
    const endCX   = Math.min(MR2.mapWidth  - 1, Math.ceil((this.viewX + W / this.zoom) / CS) + 2);
    const startCY = Math.max(0, Math.floor(this.viewY / RS) - 1);
    const endCY   = Math.min(MR2.mapHeight - 1, Math.ceil((this.viewY + H / this.zoom) / RS) + 2);

    // Use floor for min (round inward) and floor for max too, but add buffer
    // chunks on top.  Clamp max to the last valid chunk origin (map size - step).
    const chunkMinX = Math.max(0,                    Math.floor(startCX / step) * step - buffer * step);
    const chunkMaxX = Math.min(MR2.mapWidth  - step, Math.floor(endCX   / step) * step + buffer * step);
    const chunkMinY = Math.max(0,                    Math.floor(startCY / step) * step - buffer * step);
    const chunkMaxY = Math.min(MR2.mapHeight - step, Math.floor(endCY   / step) * step + buffer * step);

    // Grow by one extra step to catch partial chunks at the visible edge
    const safeMaxX = Math.min(MR2.mapWidth  - step, chunkMaxX + step);
    const safeMaxY = Math.min(MR2.mapHeight - step, chunkMaxY + step);

    const keys = new Set();
    for (let y = chunkMinY; y <= safeMaxY; y += step) {
      for (let x = chunkMinX; x <= safeMaxX; x += step) {
        keys.add(`${x},${y}`);
      }
    }
    return keys;
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

  countFilterMatches() {
    if (!this._hasActiveFilter()) return 0;
    let n = 0;
    for (const cell of this.cells.values()) { if (this._cellMatchesFilter(cell)) n++; }
    return n;
  }

  _hasActiveFilter() {
    if (!this.filter) return false;
    const { playerName, filterPlayerUid, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange, flingerLevels } = this.filter;
    return !!(playerName || filterPlayerUid || baseTypes.size || terrainTypes.size || towerBonusRange || resourceBonusRange || flingerLevels?.size);
  }

  _cellMatchesFilter(cell) {
    const f = this.filter;
    if (!f) return false;
    const i = cell.i ?? 0;

    // AND logic between active groups — every active group must pass.
    // Within each group the check is OR (any selected value matches).

    // ── Player filter ────────────────────────────────────────────────────────
    // Uid match (exact) when a suggestion was selected; substring on free text.
    if (f.filterPlayerUid) {
      if (cell.uid !== f.filterPlayerUid) return false;
    } else if (f.playerName) {
      if (!(cell.uid > 0 && cell.n && cell.n.toLowerCase().includes(f.playerName))) return false;
    }

    // ── Base type ────────────────────────────────────────────────────────────
    if (f.baseTypes.size) {
      const baseMatch =
        (f.baseTypes.has("main")        && cell.b === MR2.cellTypes.HOMECELL) ||
        (f.baseTypes.has("outpost")     && cell.b === MR2.cellTypes.OUTPOST)  ||
        (f.baseTypes.has("wildmonster") && cell.b === MR2.cellTypes.WM);
      if (!baseMatch) return false;
    }

    // ── Terrain type ─────────────────────────────────────────────────────────
    if (f.terrainTypes.size) {
      const terrainMatch =
        (f.terrainTypes.has("water") && i <= 99)             ||
        (f.terrainTypes.has("sand")  && i > 99  && i <= 110) ||
        (f.terrainTypes.has("grass") && i > 110 && i <= 170) ||
        (f.terrainTypes.has("rock")  && i > 170);
      if (!terrainMatch) return false;
    }

    // ── Bonus ranges — only meaningful for outposts on land ──────────────────
    // If either slider is narrowed from its limit it acts as an additional AND
    // constraint. A non-outpost cell fails this group automatically.
    if (f.towerBonusRange || f.resourceBonusRange) {
      if (cell.b !== MR2.cellTypes.OUTPOST || i <= 99) return false;
      const ALT_AVG = 125;
      const tower   = Math.round(i * 100 / ALT_AVG - 100);
      const res     = Math.round(100 * ALT_AVG / i - 100);
      if (f.towerBonusRange    && !(tower >= f.towerBonusRange.min    && tower <= f.towerBonusRange.max))    return false;
      if (f.resourceBonusRange && !(res   >= f.resourceBonusRange.min && res   <= f.resourceBonusRange.max)) return false;
    }

    // ── Flinger level — outposts only ────────────────────────────────────────
    if (f.flingerLevels?.size) {
      if (cell.b !== MR2.cellTypes.OUTPOST) return false;
      const flingerLv = Number(cell.f) || 0;
      if (!f.flingerLevels.has(flingerLv)) return false;
    }

    return true;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

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

    // Precompute scaled vertex flat array for this zoom [vx*z, vy*z, ...]
    const zv = new Float32Array(12);
    for (let i = 0; i < 6; i++) {
      zv[i * 2]     = HEX_VERTICES[i][0] * zoom;
      zv[i * 2 + 1] = HEX_VERTICES[i][1] * zoom;
    }

    const useRect     = zoom < RECT_ZOOM;
    const rw          = HW * zoom + 1;  // +1 fills sub-pixel gaps between cells
    const rh          = HH * zoom + 1;
    const filterActive = this._hasActiveFilter();

    // Visible cell range — column-offset grid uses CS (col step) and RS (row step)
    const startCX = Math.max(0, Math.floor(this.viewX / CS) - 2);
    const endCX   = Math.min(MR2.mapWidth  - 1, Math.ceil((this.viewX + W / zoom) / CS) + 2);
    const startCY = Math.max(0, Math.floor(this.viewY / RS) - 1);
    const endCY   = Math.min(MR2.mapHeight - 1, Math.ceil((this.viewY + H / zoom) / RS) + 2);

    // ── Single pass: collect positions into colour-keyed buckets ─────────────
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

        // Terrain
        const fill = getTileDef(cell?.i ?? 0).fill;
        let tb = terrain.get(fill);
        if (!tb) { tb = []; terrain.set(fill, tb); }
        tb.push(sx, sy);

        // Base overlay — tribe cells get a light gray tint; player cells get colour
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

        // Filter
        if (filterActive && cell) {
          if (this._cellMatchesFilter(cell)) fHit.push(sx, sy);
          else fDim.push(sx, sy);
        }
      }
    }

    // ── Batch draw: one fill() per unique colour ──────────────────────────────
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

    for (const [color, pos] of terrain) fillBucket(color, pos);
    for (const [color, pos] of overlay) fillBucket(color, pos);

    if (filterActive) {
      fillBucket(COL_DIM_FILL,    fDim);
      fillBucket(COL_FILTER_FILL, fHit);
    }

    // ── Hover / selected ─────────────────────────────────────────────────────
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

    // ── Grid lines ───────────────────────────────────────────────────────────
    if (zoom >= GRID_ZOOM) {
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

    // ── Labels ────────────────────────────────────────────────────────────────
    if (zoom >= LABEL_ZOOM) {
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

          // White text with dark outline — readable on any overlay colour.
          // Tinted slightly to hint at whose cell it is while keeping contrast.
          const nameColor = cell.uid === 0
            ? "rgba(255,255,255,0.70)"   // tribe — subtle white
            : cell.mine === 1
              ? (isHomeLabel ? "#ffffff"  : "#cceeff")  // my home / my outpost
              : (isHomeLabel ? "#ffffff"  : "#fff0cc");  // other home / other outpost

          if (zoom >= LABEL_FULL_ZOOM) {
            // Name
            ctx.font      = `bold ${Math.min(hhPx * 0.22, 12)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.88)";
            ctx.strokeText(cell.n.substring(0, 12), sx, sy - hhPx * 0.1);
            ctx.fillStyle = nameColor;
            ctx.fillText(cell.n.substring(0, 12),   sx, sy - hhPx * 0.1);
            // Level
            ctx.font      = `${Math.min(hhPx * 0.18, 10)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 2;
            ctx.strokeText(`Lv ${cell.l ?? "?"}`, sx, sy + hhPx * 0.15);
            ctx.fillStyle = "rgba(255,255,255,0.82)";
            ctx.fillText(`Lv ${cell.l ?? "?"}`,   sx, sy + hhPx * 0.15);
          } else {
            // Name — shift up slightly to make room for level below
            ctx.font      = `bold ${Math.min(hhPx * 0.22, 11)}px "Trebuchet MS", sans-serif`;
            ctx.lineWidth = 2;
            ctx.strokeStyle = "rgba(0,0,0,0.88)";
            ctx.strokeText(cell.n.substring(0, 8), sx, sy - hhPx * 0.1);
            ctx.fillStyle = nameColor;
            ctx.fillText(cell.n.substring(0, 8),   sx, sy - hhPx * 0.1);
            // Level
            ctx.font      = `${Math.min(hhPx * 0.18, 9)}px "Trebuchet MS", sans-serif`;
            ctx.strokeText(`Lv ${cell.l ?? "?"}`, sx, sy + hhPx * 0.15);
            ctx.fillStyle = "rgba(255,255,255,0.82)";
            ctx.fillText(`Lv ${cell.l ?? "?"}`,   sx, sy + hhPx * 0.15);
          }
        }
      }
    }

    // ── Map border ────────────────────────────────────────────────────────────
    // Total world extent: columns span CS * mapWidth + extra quarter; rows RS * mapHeight + CO for odd-col offset
    ctx.strokeStyle = "rgba(100,160,255,0.40)";
    ctx.lineWidth   = 2;
    ctx.strokeRect(
      -this.viewX * zoom,
      -this.viewY * zoom,
      (MR2.mapWidth  * CS + HW / 4) * zoom,
      (MR2.mapHeight * RS + CO)     * zoom,
    );
  }

  // ─── Coordinate helpers ──────────────────────────────────────────────────────

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

  // ─── Events ──────────────────────────────────────────────────────────────────

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
