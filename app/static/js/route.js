// Hex-grid distance and takeover-route tools for MR2's flat-top, "odd-q"
// offset grid, wraparound-aware (col/row 799 is adjacent to 0).

import { MR2 } from "./shared.js";

const WORLD_W = MR2.mapWidth;
const WORLD_H = MR2.mapHeight;

// Abunakki camps >= this level have a defended garrison (server's tribeSaveV2 tier split).
export const ABUNAKKI_HARD_LEVEL = 35;

// Ordered smallest range first — tierForRange()/KIT_TIERS[0] rely on that.
export const KIT_TIERS = [
  { range: 2, name: "Regular", cost: { twigs: 12_000_000, pebbles: 12_000_000, putty: 6_000_000 } },
  { range: 3, name: "Mega",    cost: { twigs: 50_000_000, pebbles: 50_000_000, putty: 25_000_000 } },
  { range: 4, name: "Ultra",   cost: { twigs: 200_000_000, pebbles: 200_000_000, putty: 100_000_000 } },
];

export function kitCostTotal(cost) {
  return cost.twigs + cost.pebbles + cost.putty;
}

function tierForRange(distance) {
  return KIT_TIERS.find((t) => t.range >= distance) || KIT_TIERS[KIT_TIERS.length - 1];
}

// Takeover cost, from the game client's PopupTakeover.as. Wild camps price by camp
// level; outposts (and home bases, though those are unreachable — see isPassable())
// price by a log curve on empirevalue, capped at 65M. Charged in full to each of
// twigs/pebbles/putty/goo, not split. Unlike kit cost, supports instant Shiny payment.
const WILD_TAKEOVER_SLOPE     = 562_500;
const WILD_TAKEOVER_INTERCEPT = -14_750_000;
const PLAYER_TAKEOVER_SLOPE     = 15_820_570.7;
const PLAYER_TAKEOVER_INTERCEPT = -227_080_916.9;
const TAKEOVER_ROUND_TO = 250_000;
const TAKEOVER_MIN = 1_000_000;
const TAKEOVER_MAX = 65_000_000; // player cells only

/** Cost required of each resource (twigs/pebbles/putty/goo) to take over `cell`. */
export function takeoverCost(cell, { adjacentToHome = false } = {}) {
  if (!cell) return 0;
  let cost;
  if (cell.uid === 0) {
    const level = cell.l ?? 0;
    cost = Math.max(
      Math.round((level * WILD_TAKEOVER_SLOPE + WILD_TAKEOVER_INTERCEPT) / TAKEOVER_ROUND_TO) * TAKEOVER_ROUND_TO,
      TAKEOVER_MIN,
    );
  } else {
    const value = cell.v ?? 0;
    if (value <= 0) return TAKEOVER_MIN;
    cost = Math.min(
      Math.max(
        Math.round((Math.log(value) * PLAYER_TAKEOVER_SLOPE + PLAYER_TAKEOVER_INTERCEPT) / TAKEOVER_ROUND_TO) * TAKEOVER_ROUND_TO,
        TAKEOVER_MIN,
      ),
      TAKEOVER_MAX,
    );
  }
  return adjacentToHome ? cost / 2 : cost;
}

/** Instant Shiny price for a takeover already priced via takeoverCost(). */
export function shinyTakeoverCost(resourceCost) {
  return Math.ceil(Math.pow(resourceCost / 2, 0.375) * 4);
}

// Offset (col,row) <-> axial hex coords, matching cellToWorld() in map-renderer.js.
function offsetToAxial(col, row) {
  const q = col;
  const r = row - (col - (col & 1)) / 2;
  return { q, r };
}

function axialToOffset(q, r) {
  const col = q;
  const row = r + (q - (q & 1)) / 2;
  return { col, row };
}

function axialDistance(q1, r1, q2, r2) {
  const dq = q1 - q2;
  const dr = r1 - r2;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/** Hex-step distance between two cells, no wraparound. */
export function hexDistance(x1, y1, x2, y2) {
  const a = offsetToAxial(x1, y1);
  const b = offsetToAxial(x2, y2);
  return axialDistance(a.q, a.r, b.q, b.r);
}

/** Hex-step distance accounting for world wraparound; also returns the winning (dx, dy) translation. */
export function wrappedHexDistance(x1, y1, x2, y2) {
  let best = Infinity;
  let bestDX = 0;
  let bestDY = 0;
  for (const dx of [-WORLD_W, 0, WORLD_W]) {
    for (const dy of [-WORLD_H, 0, WORLD_H]) {
      const d = hexDistance(x1, y1, x2 + dx, y2 + dy);
      if (d < best) {
        best = d;
        bestDX = dx;
        bestDY = dy;
      }
    }
  }
  return { distance: best, dx: bestDX, dy: bestDY };
}

function wrap(n, size) {
  return ((n % size) + size) % size;
}

/** Every cell within `range` hex-steps of (x, y), wraparound-aware, excluding (x, y) itself. */
function neighborsWithin(x, y, range) {
  const { q: cq, r: cr } = offsetToAxial(x, y);
  const out = [];
  for (let dq = -range; dq <= range; dq++) {
    const drMin = Math.max(-range, -dq - range);
    const drMax = Math.min(range, -dq + range);
    for (let dr = drMin; dr <= drMax; dr++) {
      if (dq === 0 && dr === 0) continue;
      const { col, row } = axialToOffset(cq + dq, cr + dr);
      out.push({ x: wrap(col, WORLD_W), y: wrap(row, WORLD_H) });
    }
  }
  return out;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

/**
 * A* takeover-route planner over the hex grid.
 *
 * @param {(x: number, y: number) => object|null} getCell water/unloaded cells are null
 * @param {{x,y}} start
 * @param {{x,y}} target
 * @param {object} [options]
 * @param {number} [options.jumpCap=4] max hex-distance per hop (2/3/4 = Regular/Mega/Ultra)
 * @param {boolean} [options.allowPlayers=true] allow stepping through other players' cells (target is always reachable regardless)
 * @param {boolean} [options.skipHardAbunakki=false] treat ABUNAKKI_HARD_LEVEL+ camps as impassable stepping stones
 * @param {"hops"|"kitCost"} [options.costMode="hops"] minimize jump count, or total kit+takeover spend
 * @param {number} [options.forceTierRange] bill every hop at this tier's flat cost regardless of distance
 * @param {number} [options.firstHopRange=0] start's already-built flinger range — first hop is free of kit cost (still charges takeover cost)
 * @param {{x,y}} [options.homeCell] player's real home position, for takeoverCost()'s adjacency discount
 * @param {number} [options.targetRadius=0] if >0, target isn't captured directly (e.g. it's a home base) —
 *   the route ends on any real, ownable cell within this many hexes of it, priced normally, with a
 *   free zero-cost final hop appended onto the actual target coordinates for display.
 * @param {number} [options.exemptUid] this uid's own cells are always valid stepping stones/endpoints,
 *   even with allowPlayers false — for routing through a target's own outposts to reach their main yard.
 * @param {number} [options.maxNodes=200000] safety valve on A* expansions
 * @returns {{path, hops, totalHops, totalCost, totalTakeoverCost, kitCounts}|null}
 */
export function findRoute(getCell, start, target, options = {}) {
  const {
    jumpCap = 4,
    allowPlayers = true,
    skipHardAbunakki = false,
    costMode = "hops",
    forceTierRange = null,
    firstHopRange = 0,
    homeCell = null,
    targetRadius = 0,
    exemptUid = null,
    maxNodes = 200000,
  } = options;

  const isAdjacentToHome = (x, y) =>
    !!homeCell && wrappedHexDistance(homeCell.x, homeCell.y, x, y).distance === 1;

  const isPassable = (x, y, { asTarget = false } = {}) => {
    const cell = getCell(x, y);
    if (!cell) return false;
    if (cell.i !== undefined && cell.i <= MR2.terrain.WATER3) return false;
    // Home bases can never be taken over (PopupInfoEnemy.Attack() gates on
    // cell._base != HOMECELL client-side) — applies to target and stepping stones alike.
    if (cell.b === MR2.cellTypes.HOMECELL) return false;
    // allowPlayers gates stepping stones only; the target (or exemptUid's own
    // cells, e.g. routing through a player's outposts to reach their main yard) are always reachable.
    const exempt = exemptUid != null && cell.uid === exemptUid;
    if (!asTarget && !allowPlayers && cell.uid > 0 && !exempt) return false;
    if (
      skipHardAbunakki &&
      !asTarget &&
      cell.uid === 0 &&
      cell.n === "Abunakki" &&
      (cell.l ?? 0) >= ABUNAKKI_HARD_LEVEL
    ) {
      return false;
    }
    return true;
  };

  if (targetRadius === 0 && !isPassable(target.x, target.y, { asTarget: true })) return null;

  const startKey = cellKey(start.x, start.y);
  const targetKey = cellKey(target.x, target.y);
  const reachedGoal = (x, y) =>
    targetRadius > 0
      ? wrappedHexDistance(x, y, target.x, target.y).distance <= targetRadius
      : x === target.x && y === target.y;

  const cheapestTier = KIT_TIERS[0];
  const cheapestPerHopCost = kitCostTotal(cheapestTier.cost);
  const edgeCost = (distance, tx, ty) =>
    costMode === "kitCost"
      ? kitCostTotal(tierForRange(distance).cost) + takeoverCost(getCell(tx, ty), { adjacentToHome: isAdjacentToHome(tx, ty) })
      : 1;
  const effectiveMaxHop = Math.max(jumpCap, firstHopRange || 0);
  const heuristic = (x, y) => {
    const raw = wrappedHexDistance(x, y, target.x, target.y).distance;
    const d = Math.max(0, raw - targetRadius);
    return costMode === "kitCost"
      ? Math.ceil(d / cheapestTier.range) * (cheapestPerHopCost + TAKEOVER_MIN)
      : Math.ceil(d / effectiveMaxHop);
  };

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const open = new MinHeap();
  open.push(heuristic(start.x, start.y), startKey, { x: start.x, y: start.y });

  const visited = new Set();
  let expansions = 0;
  const hasFreeFirstHop = firstHopRange > 0;
  const finalApproach = targetRadius > 0 ? target : null;

  while (!open.isEmpty()) {
    const { key, pos } = open.pop();
    if (visited.has(key)) continue;
    visited.add(key);

    if (reachedGoal(pos.x, pos.y)) {
      return reconstruct(cameFrom, pos, start, forceTierRange, hasFreeFirstHop, getCell, isAdjacentToHome, finalApproach);
    }

    if (++expansions > maxNodes) return null;

    const g = gScore.get(key);
    const isStartNode = key === startKey;
    const hopRange = isStartNode && hasFreeFirstHop ? firstHopRange : jumpCap;

    for (const n of neighborsWithin(pos.x, pos.y, hopRange)) {
      const nKey = cellKey(n.x, n.y);
      if (visited.has(nKey)) continue;
      const nIsExactTarget = targetRadius === 0 && nKey === targetKey;
      if (!nIsExactTarget && !isPassable(n.x, n.y)) continue;
      if (nIsExactTarget && !isPassable(n.x, n.y, { asTarget: true })) continue;

      const distance = hexDistance(pos.x, pos.y, n.x, n.y);
      const kitFree = isStartNode && hasFreeFirstHop;
      const tentativeG = g + (
        costMode !== "kitCost"
          ? (kitFree ? 0 : 1)
          : (kitFree ? takeoverCost(getCell(n.x, n.y), { adjacentToHome: isAdjacentToHome(n.x, n.y) }) : edgeCost(distance, n.x, n.y))
      );
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, { key, pos });
        open.push(tentativeG + heuristic(n.x, n.y), nKey, n);
      }
    }
  }

  return null;
}

function reconstruct(cameFrom, targetPos, start, forceTierRange, firstHopFree, getCell, isAdjacentToHome, finalApproach) {
  const path = [targetPos];
  let key = cellKey(targetPos.x, targetPos.y);
  while (cameFrom.has(key)) {
    const prev = cameFrom.get(key);
    path.push(prev.pos);
    key = prev.key;
  }
  path.reverse();
  if (path[0].x !== start.x || path[0].y !== start.y) path.unshift({ x: start.x, y: start.y });

  const forcedTier = forceTierRange ? KIT_TIERS.find((t) => t.range === forceTierRange) : null;

  const hops = [];
  const totalCost = { twigs: 0, pebbles: 0, putty: 0 };
  const totalTakeoverCost = { twigs: 0, pebbles: 0, putty: 0, goo: 0 };
  const kitCounts = { 2: 0, 3: 0, 4: 0 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const distance = hexDistance(a.x, a.y, b.x, b.y);

    const adjacentToHome = isAdjacentToHome ? isAdjacentToHome(b.x, b.y) : false;
    const hopTakeover = getCell ? takeoverCost(getCell(b.x, b.y), { adjacentToHome }) : 0;
    totalTakeoverCost.twigs   += hopTakeover;
    totalTakeoverCost.pebbles += hopTakeover;
    totalTakeoverCost.putty   += hopTakeover;
    totalTakeoverCost.goo     += hopTakeover;

    if (i === 1 && firstHopFree) {
      hops.push({ from: a, to: b, distance, kitTier: 0, kitName: "Existing flinger", takeoverCost: hopTakeover, adjacentToHome });
      continue;
    }

    const tier = forcedTier || tierForRange(distance);
    totalCost.twigs   += tier.cost.twigs;
    totalCost.pebbles += tier.cost.pebbles;
    totalCost.putty   += tier.cost.putty;
    kitCounts[tier.range]++;
    hops.push({ from: a, to: b, distance, kitTier: tier.range, kitName: tier.name, takeoverCost: hopTakeover, adjacentToHome });
  }
  const totalHops = hops.length;

  // A region-goal route (targetRadius > 0) never actually captures the real
  // target (e.g. a home base) — this last hop is free/uncounted, purely to
  // draw the route all the way to it and label it as the true destination.
  if (finalApproach) {
    const from = path[path.length - 1];
    hops.push({
      from, to: finalApproach, distance: hexDistance(from.x, from.y, finalApproach.x, finalApproach.y),
      kitTier: null, kitName: null, takeoverCost: 0, adjacentToHome: false, isFinalApproach: true,
    });
    path.push(finalApproach);
  }

  return { path, hops, totalHops, totalCost, totalTakeoverCost, kitCounts, hasFinalApproach: !!finalApproach };
}

// Binary min-heap, keyed by (priority, insertion order) so ties are stable.
class MinHeap {
  constructor() {
    this._items = [];
    this._seq = 0;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  push(priority, key, pos) {
    this._items.push({ priority, seq: this._seq++, key, pos });
    this._bubbleUp(this._items.length - 1);
  }

  pop() {
    const top = this._items[0];
    const last = this._items.pop();
    if (this._items.length > 0) {
      this._items[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }

  _less(a, b) {
    return a.priority !== b.priority ? a.priority < b.priority : a.seq < b.seq;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._less(this._items[i], this._items[parent])) {
        [this._items[i], this._items[parent]] = [this._items[parent], this._items[i]];
        i = parent;
      } else break;
    }
  }

  _bubbleDown(i) {
    const n = this._items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this._less(this._items[l], this._items[smallest])) smallest = l;
      if (r < n && this._less(this._items[r], this._items[smallest])) smallest = r;
      if (smallest === i) break;
      [this._items[i], this._items[smallest]] = [this._items[smallest], this._items[i]];
      i = smallest;
    }
  }
}
