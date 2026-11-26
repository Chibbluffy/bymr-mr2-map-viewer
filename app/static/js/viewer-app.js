import { ApiClient } from "./api-client.js";
import { MapRenderer } from "./map-renderer.js";
import {
  MR2,
  STABLE_VIEWER_CONFIG,
  SELECTED_WORLD_STORAGE_KEY,
  SEARCH_RESULT_LIMIT,
  buildTerrainCacheKey,
  buildSnapshotCacheKey,
  buildAllianceCacheKey,
  buildHomePosKey,
  buildRouteStorageKey,
  buildViewAsKey,
  escapeHtml,
  getTerrainLabel,
  isWater,
  sessionCacheGet,
  sessionCacheSet,
  setViewerConfig,
} from "./shared.js";
import { findRoute, wrappedHexDistance, BALANCED_HOP_PENALTY } from "./route.js";

const NO_WORLDS_MESSAGE = "No worlds have been polled yet — check back in a few minutes.";

// Per-player filter highlight colors — remembered across visits (see _loadFilterColors()),
// keyed by uid so the same rival/ally gets the same color next time they're filtered.
// Everyone starts out this same pink (same hue as the generic filter-match highlight
// elsewhere in the app) rather than an auto-cycled palette — picking a color that might
// collide with something else's meaning (the alliance yellow, say) is the player's call
// to make deliberately, not something silently assigned for them.
const FILTER_COLOR_STORAGE_KEY = "mr2FilterPlayerColors";
const DEFAULT_FILTER_COLOR = "#ff32c8";

function _loadFilterColors() {
  try {
    const raw = localStorage.getItem(FILTER_COLOR_STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return new Map(Object.entries(obj).map(([uid, color]) => [Number(uid), color]));
  } catch {
    return new Map();
  }
}

function _saveFilterColors(colors) {
  try {
    localStorage.setItem(FILTER_COLOR_STORAGE_KEY, JSON.stringify(Object.fromEntries(colors)));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — colors just won't persist.
  }
}

// Guards the global keyboard shortcuts (+/-/H/Escape) so they don't fire while typing.
function _isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// Compact number formatter: 1234567 → "1.2M", 5000 → "5K", 400 → "400"
// Negative values are clamped to 0 — they appear in the game DB as delta artefacts.
function _fmtNum(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

// Resolves a Path target's cell: closest outpost to the other endpoint. Targeting the
// player's main yard directly is a different mode entirely — see _resolvePathCells().
function _pickPathCell(pick, otherPick) {
  if (!pick || !pick.outposts.length) return null;

  const ref = otherPick?.home || otherPick?.outposts?.[0] || pick.home || pick.outposts[0];
  if (!ref) return pick.outposts[0];

  let best = pick.outposts[0];
  let bestDist = Infinity;
  for (const op of pick.outposts) {
    const { distance } = wrappedHexDistance(op.x, op.y, ref.x, ref.y);
    if (distance < bestDist) { bestDist = distance; best = op; }
  }
  return best;
}

// MR2 hard-caps home Flinger's effective level at 4 (BFOUNDATION.as), so range tops out at 10, not MR3's 12.
const HOME_FLINGER_RANGES    = [0, 4, 6, 8, 10];
const OUTPOST_FLINGER_RANGES = [0, 1, 2, 3, 4];

function _flingerRangeOf(cell) {
  if (!cell) return 0;
  const lv = Number(cell.f) || 0;
  const table = cell.b === MR2.cellTypes.HOMECELL ? HOME_FLINGER_RANGES : OUTPOST_FLINGER_RANGES;
  return table[Math.min(Math.max(lv, 0), table.length - 1)] ?? 0;
}

// Best launch cell (home or any outpost) toward the target by real flinger range.
function _pickBestLaunchCell(pick, targetCell) {
  if (!pick) return null;
  const candidates = [pick.home, ...pick.outposts].filter(Boolean);
  if (!candidates.length) return null;
  if (!targetCell) return candidates[0];

  let best = candidates[0];
  let bestRemaining = Infinity;
  let bestRange = -1;
  for (const c of candidates) {
    const range = _flingerRangeOf(c);
    const { distance } = wrappedHexDistance(c.x, c.y, targetCell.x, targetCell.y);
    const remaining = Math.max(0, distance - range);
    if (remaining < bestRemaining || (remaining === bestRemaining && range > bestRange)) {
      bestRemaining = remaining;
      bestRange = range;
      best = c;
    }
  }
  return best;
}

// Jointly picks the best (start, target outpost) pair when BOTH sides are
// still unresolved player picks — tries every combination rather than
// resolving one side off a fixed reference point (e.g. the start player's
// home) and the other off that result. That two-phase approach can produce a
// badly mismatched pair: a spread-out empire's home base is often nowhere
// near its actual closest outpost to the target, so picking the target
// relative to home first can strand the route on the wrong side of the map
// even though a much closer pair of outposts exists on both sides.
function _pickBestRoutePair(startPick, targetPick) {
  const startCandidates = [startPick?.home, ...(startPick?.outposts || [])].filter(Boolean);
  const targetCandidates = targetPick?.outposts || [];
  if (!startCandidates.length || !targetCandidates.length) {
    return { startCell: startCandidates[0] || null, targetCell: targetCandidates[0] || null };
  }

  let bestStart = startCandidates[0];
  let bestTarget = targetCandidates[0];
  let bestRemaining = Infinity;
  let bestRange = -1;
  for (const s of startCandidates) {
    const range = _flingerRangeOf(s);
    for (const t of targetCandidates) {
      const { distance } = wrappedHexDistance(s.x, s.y, t.x, t.y);
      const remaining = Math.max(0, distance - range);
      if (remaining < bestRemaining || (remaining === bestRemaining && range > bestRange)) {
        bestRemaining = remaining;
        bestRange = range;
        bestStart = s;
        bestTarget = t;
      }
    }
  }
  return { startCell: bestStart, targetCell: bestTarget };
}

// ─── ViewerApp ────────────────────────────────────────────────────────────────

export class ViewerApp {
  constructor() {
    this.api = null;
    this.config = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.searchEntries = [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.filterOpen = false;
    this._filterPlayers = new Map();  // uid → name; drives multi-player highlight
    this._filterPlayerColors = _loadFilterColors(); // uid → hex color; persisted across visits

    // ── World picker state ─────────────────────────────────────────────────
    this.polledWorlds = [];      // [{uuid, name, map_version, player_count, last_polled_at}, ...] from /api/worlds
    this.selectedWorldId = null; // uuid of the world currently on screen
    this._hadStoredWorldSelection = false;

    // ── World-load state ───────────────────────────────────────────────────
    this._worldLoaded      = false;
    this._terrainBytes     = null;
    this._worldLoadPromise = null;
    this._worldLoadGeneration = 0; // bumped on world switch; a stale in-flight load discards its result

    // ── "View as" — client-only identity; the only identity mechanism now
    // that real login is gone ───────────────────────────────────────────────
    this._viewAs = null; // {uid, name} | null
    this._allianceData = null; // { uidToAllianceId, alliancesById } | null — see _buildAllianceData()

    // ── Path tool (route planner) ──────────────────────────────────────────
    this._pathStartPick  = null;
    this._pathTargetPick = null;
    this.currentRoute     = null; // { route, originalOwners, options, startName, targetName } | null
    this._routeIsSaved    = false;

    this.elements = {
      appRoot:            document.getElementById("app"),
      worldSelect:        document.getElementById("world-select"),
      statusText:         document.getElementById("status-text"),
      detailPanel:        document.getElementById("cell-detail-panel"),
      detailsTitle:       document.getElementById("details-title"),
      detailsAvatar:      document.getElementById("details-avatar"),
      detailsContent:     document.getElementById("details-content"),
      avatarLightbox:     document.getElementById("avatar-lightbox"),
      avatarLightboxImg:  document.getElementById("avatar-lightbox-img"),
      detailsCloseButton: document.getElementById("details-close-button"),
      legendToggleButton: document.getElementById("legend-toggle-button"),
      legendPanel:        document.getElementById("legend-panel"),
      mapCanvas:          document.getElementById("map-canvas"),
      mapCoordinates:     document.getElementById("map-coordinates"),
      mapOverlay:         document.getElementById("map-overlay"),
      mapOverlayMessage:  document.getElementById("map-overlay-message"),
      loadProgress:       document.getElementById("load-progress"),
      loadProgressBar:    document.getElementById("load-progress-bar"),
      loadProgressText:   document.getElementById("load-progress-text"),
      findHomeButton:     document.getElementById("find-home-button"),
      refreshButton:      document.getElementById("refresh-button"),
      zoomInButton:       document.getElementById("zoom-in-button"),
      zoomOutButton:      document.getElementById("zoom-out-button"),
      searchToggleButton:  document.getElementById("search-toggle-button"),
      searchInput:         document.getElementById("search-input"),
      searchResults:       document.getElementById("search-results"),
      filterToggleButton:   document.getElementById("filter-toggle-button"),
      filterPanel:          document.getElementById("filter-panel"),
      filterPlayerInput:    document.getElementById("filter-player-input"),
      filterPlayerResults:  document.getElementById("filter-player-results"),
      filterClearButton:    document.getElementById("filter-clear-button"),
      filterMatchCount:     document.getElementById("filter-match-count"),

      measureToggleButton: document.getElementById("measure-toggle-button"),
      measureClearButton:  document.getElementById("measure-clear-button"),

      viewAsTriggerButton:  document.getElementById("view-as-trigger-button"),
      viewAsTriggerLabel:   document.getElementById("view-as-trigger-label"),
      viewAsPopover:        document.getElementById("view-as-popover"),
      viewAsInput:          document.getElementById("view-as-input"),
      viewAsResults:        document.getElementById("view-as-results"),
      viewAsStatus:         document.getElementById("view-as-status"),
      viewAsClearButton:    document.getElementById("view-as-clear-button"),

      pathToggleButton: document.getElementById("path-toggle-button"),
      pathPanel:         document.getElementById("path-panel"),
      pathSavedBanner:          document.getElementById("path-saved-banner"),
      pathLoadButton:           document.getElementById("path-load-button"),
      pathDiscardSavedButton:   document.getElementById("path-discard-saved-button"),
      pathClearButton:          document.getElementById("path-clear-button"),
      pathStartPlayerFields: document.getElementById("path-start-player-fields"),
      pathStartCoordsFields: document.getElementById("path-start-coords-fields"),
      pathStartX:           document.getElementById("path-start-x"),
      pathStartY:           document.getElementById("path-start-y"),
      pathStartInput:       document.getElementById("path-start-input"),
      pathStartResults:     document.getElementById("path-start-results"),
      pathStartLaunchInfo:  document.getElementById("path-start-launch-info"),
      pathTargetInfo:       document.getElementById("path-target-info"),
      pathStartUseMine:     document.getElementById("path-start-use-mine"),
      pathTargetPlayerFields: document.getElementById("path-target-player-fields"),
      pathTargetCoordsFields: document.getElementById("path-target-coords-fields"),
      pathTargetX:          document.getElementById("path-target-x"),
      pathTargetY:          document.getElementById("path-target-y"),
      pathTargetInput:      document.getElementById("path-target-input"),
      pathTargetResults:    document.getElementById("path-target-results"),
      pathDistanceReadout:  document.getElementById("path-distance-readout"),
      pathSkipHardAbunakki:    document.getElementById("path-skip-hard-abunakki"),
      pathPlanButton:          document.getElementById("path-plan-button"),
      pathResults:       document.getElementById("path-results"),
      pathResultRoute:   document.getElementById("path-result-route"),
      pathResultHops:    document.getElementById("path-result-hops"),
      pathResultCost:    document.getElementById("path-result-cost"),
      pathResultTakeover: document.getElementById("path-result-takeover"),
      pathResultTotal:    document.getElementById("path-result-total"),
      pathResultKits:    document.getElementById("path-result-kits"),
      pathProgressReadout: document.getElementById("path-progress-readout"),
      pathSaveButton:      document.getElementById("path-save-button"),
      pathStatus:          document.getElementById("path-status"),
    };
  }

  async start() {
    // Portal dropdowns to <body> — backdrop-filter on .map-tool-panel/.top-bar breaks position:fixed children.
    [
      this.elements.searchResults, this.elements.filterPlayerResults,
      this.elements.viewAsResults, this.elements.pathStartResults, this.elements.pathTargetResults,
      this.elements.viewAsPopover,
    ].forEach(el => { if (el) document.body.appendChild(el); });

    this.config = setViewerConfig({ ...STABLE_VIEWER_CONFIG });
    this.api = new ApiClient(this.config);

    this._setupMapRenderer();
    this._setupEventListeners();
    this._setupWorldSelector();

    // Captured before _initPolledWorlds() writes its own fallback to this same key.
    this._hadStoredWorldSelection = !!localStorage.getItem(SELECTED_WORLD_STORAGE_KEY);

    await this._initPolledWorlds();
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────

  _setupMapRenderer() {
    const canvas = this.elements.mapCanvas;
    if (!canvas) return;

    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    this.renderer = new MapRenderer(canvas);

    this.renderer.onCellHover = (cell) => {
      this.hoveredCell = cell;
      if (!this.selectedCell) this._renderDetails(cell);
      if (cell) {
        this.elements.mapCoordinates.textContent = `Cell ${cell.x}, ${cell.y}`;
        this.elements.mapCoordinates.hidden = false;
      } else {
        this.elements.mapCoordinates.hidden = true;
      }
    };

    this.renderer.onCellClick = (cell) => {
      this.selectedCell = cell;
      this._renderDetails(cell);
    };

    this.renderer.onCoordsChange = (x, y) => {
      if (x !== null && y !== null) {
        this.elements.mapCoordinates.textContent = `Cell ${x}, ${y}`;
        this.elements.mapCoordinates.hidden = false;
      } else {
        this.elements.mapCoordinates.hidden = true;
      }
    };

    // Resize observer
    const ro = new ResizeObserver(() => this.renderer.resize());
    ro.observe(canvas);
    this.renderer.resize();
  }

  _setupEventListeners() {
    const {
      findHomeButton,
      refreshButton,
      zoomInButton,
      zoomOutButton,
      searchToggleButton,
      searchInput,
    } = this.elements;

    findHomeButton?.addEventListener("click", () => {
      if (!this.renderer) return;
      const home = this.renderer.findHomeCell();
      if (home) this._jumpTo(home.x, home.y);
    });

    // Sole reload control — combines what used to be two separate buttons
    // (refresh-button and a since-removed standalone bg-load-button).
    refreshButton?.addEventListener("click", () => {
      if (this.selectedWorldId) this._refreshMap();
    });

    zoomInButton?.addEventListener("click", () => this.renderer?.zoomIn());
    zoomOutButton?.addEventListener("click", () => this.renderer?.zoomOut());

    searchToggleButton?.addEventListener("click", () => {
      const expanded = searchToggleButton.getAttribute("aria-expanded") === "true";
      const panel = document.getElementById("search-panel");
      searchToggleButton.setAttribute("aria-expanded", String(!expanded));
      if (panel) panel.hidden = expanded;
      if (!expanded) {
        searchInput?.focus();
      } else {
        if (this.elements.searchResults) this.elements.searchResults.hidden = true;
      }
    });

    searchInput?.addEventListener("input", () => this._onSearchInput());

    this._setupFilterPanel();
    this._setupLegendPanel();
    this._setupViewAs();
    this._setupPathPanel();
    this._setupMeasureTool();
    this._setupAvatarLightbox();

    // Re-clamp the View As popover if it's open on resize/orientation change —
    // its position is computed once at open time, not tracked continuously.
    window.addEventListener("resize", () => {
      const { viewAsPopover, viewAsTriggerButton } = this.elements;
      if (viewAsPopover && !viewAsPopover.hidden) this._positionPopover(viewAsPopover, viewAsTriggerButton, 280, { align: "right" });
    });

    this.elements.detailsCloseButton?.addEventListener("click", () => this._deselectCell());

    // Delegated — content.innerHTML is rebuilt on every _renderDetails() call, so a
    // listener on the element itself wouldn't survive the next hover/click.
    const handleDetailsAction = (target) => {
      const nameEl = target.closest(".detail-player-name");
      if (nameEl) {
        this._addPlayerToFilter(Number(nameEl.dataset.uid) || null, nameEl.dataset.name);
        return;
      }
      const homeLink = target.closest(".detail-go-home-link");
      if (homeLink) this._jumpTo(Number(homeLink.dataset.x), Number(homeLink.dataset.y));
    };
    this.elements.detailsContent?.addEventListener("click", (e) => handleDetailsAction(e.target));
    this.elements.detailsContent?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!e.target.closest(".detail-player-name, .detail-go-home-link")) return;
      e.preventDefault();
      handleDetailsAction(e.target);
    });

    // Keyboard shortcuts — ignored while typing (_isTypingInField()).
    document.addEventListener("keydown", (e) => {
      if (_isTypingInField()) return;
      if (e.key === "+" || e.key === "=") this.renderer?.zoomIn();
      if (e.key === "-") this.renderer?.zoomOut();
      if (e.key === "h" || e.key === "H") {
        const home = this.renderer?.findHomeCell();
        if (home) this._jumpTo(home.x, home.y);
      }
      if (e.key === "m" || e.key === "M") this._toggleMeasureMode();
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.renderer?.measurements?.length) { e.preventDefault(); this.renderer.clearMeasurements(); }
      }
      if (e.key === "Escape") {
        if (this.elements.avatarLightbox && !this.elements.avatarLightbox.hidden) {
          this._closeAvatarLightbox();
          return;
        }
        this._deselectCell();
        if (this.renderer?.measureMode) this._setMeasureMode(false);
      }
    });
  }

  // ─── Legend panel (bottom-right toggle) ──────────────────────────────────────

  _setupLegendPanel() {
    const { legendToggleButton, legendPanel } = this.elements;
    if (!legendToggleButton || !legendPanel) return;

    legendToggleButton.addEventListener("click", () => {
      const show = legendPanel.hidden;
      legendPanel.hidden = !show;
      legendToggleButton.setAttribute("aria-expanded", String(show));
    });

    document.addEventListener("click", (e) => {
      if (legendPanel.hidden) return;
      if (legendPanel.contains(e.target) || legendToggleButton.contains(e.target)) return;
      legendPanel.hidden = true;
      legendToggleButton.setAttribute("aria-expanded", "false");
    }, true);
  }

  // ─── Username autocomplete (shared by View As and Path start/target) ───────

  // onClear (optional) fires on every keystroke, before re-searching — so an already-resolved
  // pick doesn't silently keep pointing at whatever name used to be typed once the text changes.
  _setupNameAutocomplete(input, resultsEl, onPick, onClear) {
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
      onClear?.();
      const query = input.value.trim().toLowerCase();
      if (!query) { resultsEl.hidden = true; return; }

      const seen = new Set();
      const matches = [];
      for (const c of this.searchEntries) {
        if (!c.n || seen.has(c.uid) || !c.n.toLowerCase().includes(query)) continue;
        seen.add(c.uid);
        matches.push(c);
        if (matches.length >= 20) break;
      }

      if (!matches.length) { resultsEl.hidden = true; return; }

      resultsEl.innerHTML = matches
        .map((c, i) => `<button class="search-result-item" data-index="${i}" type="button">${escapeHtml(c.n)}</button>`)
        .join("");
      this._positionDropdown(resultsEl, input);
      resultsEl.hidden = false;

      resultsEl.querySelectorAll(".search-result-item").forEach((btn, i) => {
        btn.addEventListener("click", () => {
          input.value = matches[i].n;
          resultsEl.hidden = true;
          onPick(matches[i]);
        });
      });
    });

    input.addEventListener("blur", () => {
      // Typing the exact name and tabbing/tapping away without ever clicking a suggestion
      // should still resolve it — otherwise the field visibly has the right name in it, but
      // nothing downstream (e.g. Plan Route staying disabled) explains why it doesn't count.
      const query = input.value.trim().toLowerCase();
      if (query) {
        const exact = this.searchEntries.find((c) => c.n && c.n.toLowerCase() === query);
        if (exact) onPick(exact);
      }
      setTimeout(() => { resultsEl.hidden = true; }, 150);
    });
  }

  // ─── "View as" — client-only identity, no login ─────────────────────────────

  _setupViewAs() {
    const { viewAsTriggerButton, viewAsPopover, viewAsInput, viewAsResults, viewAsClearButton } = this.elements;
    if (!viewAsTriggerButton || !viewAsPopover) return;

    viewAsTriggerButton.addEventListener("click", () => this._toggleViewAsPopover());

    document.addEventListener("click", (e) => {
      if (viewAsPopover.hidden) return;
      if (viewAsPopover.contains(e.target) || viewAsTriggerButton.contains(e.target) || viewAsResults?.contains(e.target)) return;
      this._closeViewAsPopover();
    }, true);

    this._setupNameAutocomplete(viewAsInput, viewAsResults, (entry) => {
      this._setViewAs(entry.uid, entry.n);
    }, () => {
      this._viewAs = null;
      this._updateIdentityAvailability();
      this._updateViewAsUI();
    });

    viewAsClearButton?.addEventListener("click", () => this._clearViewAs());
  }

  _toggleViewAsPopover() {
    if (this.elements.viewAsPopover?.hidden) this._openViewAsPopover();
    else this._closeViewAsPopover();
  }

  _openViewAsPopover() {
    const { viewAsPopover, viewAsTriggerButton, viewAsInput } = this.elements;
    if (!viewAsPopover) return;
    this._positionPopover(viewAsPopover, viewAsTriggerButton, 280, { align: "right" });
    viewAsPopover.hidden = false;
    viewAsTriggerButton?.setAttribute("aria-expanded", "true");
    viewAsInput?.focus();
  }

  _closeViewAsPopover() {
    const { viewAsPopover, viewAsTriggerButton } = this.elements;
    if (!viewAsPopover) return;
    viewAsPopover.hidden = true;
    viewAsTriggerButton?.setAttribute("aria-expanded", "false");
  }

  // Identity driving "mine"/find-home/route progress — View As is the only
  // source now that real login is gone.
  _effectiveIdentity() {
    return this._viewAs;
  }

  _effectiveMyUid() {
    return this._effectiveIdentity()?.uid ?? null;
  }

  _setViewAs(uid, name) {
    if (!this.selectedWorldId) return;
    this._viewAs = { uid, name };
    try {
      localStorage.setItem(buildViewAsKey(this.selectedWorldId), JSON.stringify(this._viewAs));
    } catch { /* best-effort — this is a convenience feature, not critical */ }
    this._updateIdentityAvailability(); // re-derives renderer.myUserId, find-home, and the route's progress markers
    this._updateViewAsUI();
  }

  _clearViewAs() {
    if (!this.selectedWorldId) return;
    this._viewAs = null;
    localStorage.removeItem(buildViewAsKey(this.selectedWorldId));
    if (this.elements.viewAsInput) this.elements.viewAsInput.value = "";
    this._updateIdentityAvailability();
    this._updateViewAsUI();
  }

  // Called from _selectWorld() — "View as" is per-world, same as home position.
  _loadViewAsForWorld() {
    this._viewAs = null;
    if (!this.selectedWorldId) return;
    try {
      const raw = localStorage.getItem(buildViewAsKey(this.selectedWorldId));
      this._viewAs = raw ? JSON.parse(raw) : null;
    } catch {
      this._viewAs = null;
    }
  }

  _updateViewAsUI() {
    const { viewAsTriggerLabel, viewAsStatus, viewAsClearButton, viewAsInput } = this.elements;
    if (viewAsTriggerLabel) viewAsTriggerLabel.textContent = this._viewAs ? `Viewing as: ${this._viewAs.name}` : "View as…";
    if (viewAsStatus) {
      viewAsStatus.textContent = this._viewAs
        ? `Highlighting cells owned by "${this._viewAs.name}" as yours on this world.`
        : "";
    }
    if (viewAsClearButton) viewAsClearButton.hidden = !this._viewAs;
    if (viewAsInput && this._viewAs && document.activeElement !== viewAsInput) viewAsInput.value = this._viewAs.name;

    if (this.elements.pathStartUseMine) this.elements.pathStartUseMine.hidden = !this._effectiveIdentity();
  }

  // ─── Path tool (route planner) — findRoute() + MapRenderer.setRoute() ──────

  _setupPathPanel() {
    const {
      pathToggleButton, pathPanel,
      pathStartInput, pathStartResults, pathStartUseMine,
      pathTargetInput, pathTargetResults,
      pathPlanButton, pathClearButton, pathSaveButton,
      pathLoadButton, pathDiscardSavedButton,
    } = this.elements;
    if (!pathToggleButton || !pathPanel) return;

    pathToggleButton.addEventListener("click", () => {
      const show = pathPanel.hidden;
      pathPanel.hidden = !show;
      pathToggleButton.setAttribute("aria-expanded", String(show));
    });

    // pathStartResults/pathTargetResults are portaled to <body>, so check them
    // separately or picking a suggestion closes the panel out from under you.
    document.addEventListener("click", (e) => {
      if (pathPanel.hidden) return;
      const bar = document.querySelector(".map-tool-bar-left");
      const inResults = pathStartResults?.contains(e.target) || pathTargetResults?.contains(e.target);
      if (bar && !bar.contains(e.target) && !inResults) {
        pathPanel.hidden = true;
        pathToggleButton.setAttribute("aria-expanded", "false");
      }
    }, true);

    const clearPathStart = () => {
      this._pathStartPick = null;
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo();
      this._updatePathPlanAvailability();
    };
    const clearPathTarget = () => {
      this._pathTargetPick = null;
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo();
      this._updatePathPlanAvailability();
    };

    this._setupNameAutocomplete(pathStartInput, pathStartResults, (entry) => {
      this._pathStartPick = this._findPlayerByName(entry.n);
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo();
      this._updatePathPlanAvailability();
    }, clearPathStart);

    this._setupNameAutocomplete(pathTargetInput, pathTargetResults, (entry) => {
      this._pathTargetPick = this._findPlayerByName(entry.n);
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo(); // start's auto-pick depends on target too
      this._updatePathPlanAvailability();
    }, clearPathTarget);

    // Which of the target's outposts to route to — closest to your start (default)
    // or closest to their own main yard.
    document.querySelectorAll('input[name="path-target-outpost-ref"]')
      .forEach((el) => el.addEventListener("change", () => {
        this._updatePathDistanceReadout();
        this._updatePathStartLaunchInfo();
        this._updatePathPlanAvailability();
      }));

    // Player vs. coordinates — independent per side, so e.g. a start pinned
    // by username can target an arbitrary point, or vice versa.
    document.querySelectorAll('input[name="path-start-mode"]')
      .forEach((el) => el.addEventListener("change", () => this._updatePathModeVisibility("start")));
    document.querySelectorAll('input[name="path-target-mode"]')
      .forEach((el) => el.addEventListener("change", () => this._updatePathModeVisibility("target")));

    [this.elements.pathStartX, this.elements.pathStartY, this.elements.pathTargetX, this.elements.pathTargetY]
      .forEach((el) => el?.addEventListener("input", () => {
        this._updatePathDistanceReadout();
        this._updatePathStartLaunchInfo();
        this._updatePathPlanAvailability();
      }));

    pathStartUseMine?.addEventListener("click", () => {
      const id = this._effectiveIdentity();
      if (!id || !pathStartInput) return;
      const playerRadio = document.querySelector('input[name="path-start-mode"][value="player"]');
      if (playerRadio) { playerRadio.checked = true; this._updatePathModeVisibility("start"); }
      pathStartInput.value = id.name;
      this._pathStartPick = this._findPlayerByName(id.name);
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo();
      this._updatePathPlanAvailability();
    });

    pathPlanButton?.addEventListener("click", () => this._planRoute());
    pathClearButton?.addEventListener("click", () => this._clearRouteDisplay());
    pathSaveButton?.addEventListener("click", () => this._saveCurrentRoute());
    pathLoadButton?.addEventListener("click", () => {
      const saved = this._readSavedRoute();
      if (saved) this._applyRoute(saved, { fromStorage: true, fitView: true });
    });
    pathDiscardSavedButton?.addEventListener("click", () => this._discardSavedRoute());
  }

  // Exact (case-insensitive) name match against loaded cells; returns uid + every loaded base.
  _findPlayerByName(name) {
    const query = (name || "").trim().toLowerCase();
    if (!query || !this.renderer) return null;

    let uid = null, displayName = null, home = null;
    const outposts = [];
    for (const cell of this.renderer.cells.values()) {
      if (!(cell.uid > 0 && cell.n) || cell.n.toLowerCase() !== query) continue;
      uid = cell.uid;
      displayName = cell.n;
      if (cell.b === MR2.cellTypes.HOMECELL) home = cell;
      else if (cell.b === MR2.cellTypes.OUTPOST) outposts.push(cell);
    }
    if (uid === null) return null;
    return { uid, name: displayName, home, outposts };
  }

  /** Validated {x, y} from the coordinate fields for one side, or null. */
  _readPathCoords(side) {
    const xEl = side === "start" ? this.elements.pathStartX : this.elements.pathTargetX;
    const yEl = side === "start" ? this.elements.pathStartY : this.elements.pathTargetY;
    const x = Number(xEl?.value);
    const y = Number(yEl?.value);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || x >= MR2.mapWidth || y < 0 || y >= MR2.mapHeight) return null;
    return { x, y };
  }

  // Their main yard can never actually be captured, but it's still the real
  // destination when picked — see _planRoute()'s targetRadius/exemptUid options.
  _pathTargetIsMainYard() {
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";
    const ref = document.querySelector('input[name="path-target-outpost-ref"]:checked')?.value || "start";
    return targetMode === "player" && ref === "home";
  }

  // Each side is independently "player" or "coordinates". Whenever one side
  // is pinned to fixed coordinates (or the target is the player's own main
  // yard), the other resolves relative to that single fixed point. When
  // BOTH sides are still unresolved player picks, there's no fixed
  // reference to resolve either one against first — _pickBestRoutePair()
  // searches every (start outpost, target outpost) combination jointly
  // instead, so the pair actually minimizes real launch distance rather
  // than being anchored to (say) the start player's home base, which is
  // often nowhere near their closest outpost to the target.
  _resolvePathCells() {
    const startMode  = document.querySelector('input[name="path-start-mode"]:checked')?.value  || "player";
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";

    const startCoords  = startMode  === "coords" ? this._readPathCoords("start")  : null;
    const targetCoords = targetMode === "coords" ? this._readPathCoords("target") : null;
    const mainYardTarget = this._pathTargetIsMainYard();

    let startCell;
    let targetCell;

    if (targetMode === "coords") {
      targetCell = targetCoords;
      startCell = startMode === "coords" ? startCoords : _pickBestLaunchCell(this._pathStartPick, targetCell);
    } else if (mainYardTarget) {
      targetCell = this._pathTargetPick?.home ?? null;
      startCell = startMode === "coords" ? startCoords : _pickBestLaunchCell(this._pathStartPick, targetCell);
    } else if (startMode === "coords") {
      targetCell = _pickPathCell(this._pathTargetPick, { home: startCoords, outposts: [] });
      startCell = startCoords;
    } else {
      const pair = _pickBestRoutePair(this._pathStartPick, this._pathTargetPick);
      startCell = pair.startCell;
      targetCell = pair.targetCell;
    }

    const startRange = startMode === "player" ? _flingerRangeOf(startCell) : 0;

    return { startCell, targetCell, startRange, mainYardTarget };
  }

  _updatePathModeVisibility(side) {
    const mode = document.querySelector(`input[name="path-${side}-mode"]:checked`)?.value || "player";
    const playerFields = side === "start" ? this.elements.pathStartPlayerFields : this.elements.pathTargetPlayerFields;
    const coordsFields = side === "start" ? this.elements.pathStartCoordsFields : this.elements.pathTargetCoordsFields;
    if (playerFields) playerFields.hidden = mode !== "player";
    if (coordsFields) coordsFields.hidden = mode !== "coords";
    this._updatePathDistanceReadout();
    this._updatePathStartLaunchInfo();
    this._updatePathPlanAvailability();
  }

  _updatePathDistanceReadout() {
    const el = this.elements.pathDistanceReadout;
    if (!el) return;
    const { startCell, targetCell, mainYardTarget } = this._resolvePathCells();
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";
    if (targetMode === "player" && this._pathTargetPick && !mainYardTarget && !this._pathTargetPick.outposts.length) {
      el.textContent = `${escapeHtml(this._pathTargetPick.name)} has no outposts loaded — their home base can't be taken over, so there's no valid target here.`;
      el.hidden = false;
      return;
    }
    if (targetMode === "player" && this._pathTargetPick && mainYardTarget && !this._pathTargetPick.home) {
      el.textContent = `${escapeHtml(this._pathTargetPick.name)}'s home base isn't loaded on this world.`;
      el.hidden = false;
      return;
    }
    if (!startCell || !targetCell) { el.hidden = true; return; }
    const { distance } = wrappedHexDistance(startCell.x, startCell.y, targetCell.x, targetCell.y);
    el.textContent = `Straight-line distance: ${distance} hex${distance === 1 ? "" : "es"}`;
    el.hidden = false;
  }

  _updatePathTargetInfo() {
    const el = this.elements.pathTargetInfo;
    if (!el) return;

    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";
    if (targetMode !== "player" || !this._pathTargetPick) { el.hidden = true; return; }

    const { targetCell, mainYardTarget } = this._resolvePathCells();
    if (!targetCell) {
      el.textContent = mainYardTarget
        ? `${escapeHtml(this._pathTargetPick.name)}'s home base isn't loaded on this world.`
        : `${escapeHtml(this._pathTargetPick.name)} has no outposts loaded — their home base can't be taken over, so there's no valid target.`;
      el.hidden = false;
      return;
    }

    el.textContent = mainYardTarget
      ? `Targeting ${escapeHtml(this._pathTargetPick.name)}'s main yard at (${targetCell.x}, ${targetCell.y}) — never actually captured, the route just ends once you're in range.`
      : `Targeting ${escapeHtml(this._pathTargetPick.name)}'s outpost at (${targetCell.x}, ${targetCell.y}).`;
    el.hidden = false;
  }

  _updatePathStartLaunchInfo() {
    this._updatePathTargetInfo();
    const el = this.elements.pathStartLaunchInfo;
    if (!el) return;

    const startMode = document.querySelector('input[name="path-start-mode"]:checked')?.value || "player";
    if (startMode !== "player" || !this._pathStartPick) { el.hidden = true; return; }

    const { startCell, targetCell, startRange } = this._resolvePathCells();
    if (!startCell) {
      el.textContent = `${escapeHtml(this._pathStartPick.name)} has no loaded base to launch from.`;
      el.hidden = false;
      return;
    }

    const isHome = startCell.b === MR2.cellTypes.HOMECELL;
    const place = isHome ? "home base" : "outpost";
    if (startRange <= 0) {
      el.textContent = `Launching from ${escapeHtml(this._pathStartPick.name)}'s ${place} at (${startCell.x}, ${startCell.y}) — no flinger built here yet, every hop will need a new kit.`;
    } else if (targetCell) {
      const { distance } = wrappedHexDistance(startCell.x, startCell.y, targetCell.x, targetCell.y);
      const reachesDirect = distance <= startRange;
      el.textContent = `Launching from ${escapeHtml(this._pathStartPick.name)}'s ${place} at (${startCell.x}, ${startCell.y}) — flinger range ${startRange}${reachesDirect ? " (reaches the target directly, no kits needed)" : ""}.`;
    } else {
      el.textContent = `Launching from ${escapeHtml(this._pathStartPick.name)}'s ${place} at (${startCell.x}, ${startCell.y}) — flinger range ${startRange}.`;
    }
    el.hidden = false;
  }

  // Why Plan Route is currently disabled — surfaced live (see _updatePathPlanAvailability()),
  // not just as an error after clicking, since a disabled button never receives that click at all.
  _pathMissingEndpointReason(startCell, targetCell, mainYardTarget) {
    const startMode  = document.querySelector('input[name="path-start-mode"]:checked')?.value  || "player";
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";

    if (!startCell && startMode === "player") {
      if (this._pathStartPick) return `${this._pathStartPick.name} has no loaded base to launch from.`;
      if (this.elements.pathStartInput?.value?.trim()) return "That start player wasn't found on this world — pick a suggestion from the dropdown.";
    }
    if (!targetCell && targetMode === "player") {
      if (this._pathTargetPick && mainYardTarget && !this._pathTargetPick.home) return `${this._pathTargetPick.name}'s home base isn't loaded on this world.`;
      if (this._pathTargetPick && !mainYardTarget && !this._pathTargetPick.outposts.length) return `${this._pathTargetPick.name} has no outposts loaded — their home base can't be taken over, so there's no valid target.`;
      if (this.elements.pathTargetInput?.value?.trim()) return "That target player wasn't found on this world — pick a suggestion from the dropdown.";
    }
    return "Pick both a start and a target first.";
  }

  _updatePathPlanAvailability() {
    const btn = this.elements.pathPlanButton;
    if (!btn) return;
    const { startCell, targetCell, mainYardTarget } = this._resolvePathCells();
    const ready = !!(startCell && targetCell);
    btn.disabled = !ready;
    this._setPathStatus(ready ? "" : this._pathMissingEndpointReason(startCell, targetCell, mainYardTarget));
  }

  _planRoute() {
    if (!this.renderer) return;
    const { startCell, targetCell, startRange, mainYardTarget } = this._resolvePathCells();
    if (!startCell || !targetCell) {
      this._setPathStatus(this._pathMissingEndpointReason(startCell, targetCell, mainYardTarget));
      return;
    }

    const jumpCap         = Number(document.querySelector('input[name="path-jumpcap"]:checked')?.value) || 4;
    const allowPlayers     = document.querySelector('input[name="path-mode"]:checked')?.value === "players";
    const skipHardAbunakki = !!this.elements.pathSkipHardAbunakki?.checked;
    const routeMode        = document.querySelector('input[name="path-route-mode"]:checked')?.value || "balanced";

    this._setPathStatus("Planning…");

    const options = {
      jumpCap,
      allowPlayers,
      skipHardAbunakki,
      // Cheapest: pure resource-cost minimization. Balanced: same, but a fixed cost per hop
      // (independent of kit price) discourages a long chain of hops just to avoid a bigger
      // kit. Fastest: fewest hops outright, always at the configured max tier — cost-blind.
      costMode: routeMode === "fastest" ? "hops" : "kitCost",
      hopPenalty: routeMode === "balanced" ? BALANCED_HOP_PENALTY : 0,
      forceTierRange: routeMode === "fastest" ? jumpCap : null,
      firstHopRange: startRange,
      homeCell: this._pathStartPick?.home ?? null,
      // Their main yard is never actually captured — route ends on any real
      // cell within jump range of it, and their own outposts are always valid
      // stepping stones there even in wild-only mode (otherwise a home ringed
      // by its owner's own outposts would have no legal path in at all).
      targetRadius: mainYardTarget ? jumpCap : 0,
      exemptUid: mainYardTarget ? this._pathTargetPick?.uid ?? null : null,
    };

    const getCell = (x, y) => this.renderer.getCellAt(x, y);
    const route = findRoute(getCell, startCell, targetCell, options);

    if (!route) {
      const flingerNote = startRange <= 0
        ? " Your launch base has no flinger built, so the whole route depends on kits from the very first hop — a wider jump range may help most here."
        : "";
      this._setPathStatus(`No route found with these options — try a wider jump range, allowing player takeovers, or a different start/target.${flingerNote}`);
      return;
    }

    // "As planned" baseline for renderer._recomputeRouteStatus() to diff future state against.
    const originalOwners = route.path.map((p) => this.renderer.getCellAt(p.x, p.y)?.uid ?? 0);

    this._applyRoute({
      route, originalOwners, options,
      startName:  this._pathEndpointLabel("start",  startCell),
      targetName: this._pathEndpointLabel("target", targetCell),
    }, { fromStorage: false, fitView: true });

    this._setPathStatus("");
  }

  _pathEndpointLabel(side, cell) {
    const mode = document.querySelector(`input[name="path-${side}-mode"]:checked`)?.value || "player";
    if (mode === "player") {
      const pick = side === "start" ? this._pathStartPick : this._pathTargetPick;
      if (pick?.name) return pick.name;
    }
    return `(${cell.x}, ${cell.y})`;
  }

  // fitView is only true for a fresh plan/explicit Load, not the auto-restore on world select.
  _applyRoute(saved, { fromStorage = false, fitView = false } = {}) {
    this.currentRoute = saved;
    this._routeIsSaved = !!fromStorage;
    this.renderer?.setRoute(saved.route, this._effectiveMyUid(), saved.originalOwners);
    if (fitView) this.renderer?.fitToCells(saved.route.path);
    this._renderPathResults();
    this._updatePathSavedBanner();
  }

  _renderPathResults() {
    const {
      pathResults, pathResultRoute, pathResultHops, pathResultCost, pathResultTakeover, pathResultTotal,
      pathResultKits, pathProgressReadout,
    } = this.elements;
    if (!pathResults) return;

    const r = this.currentRoute;
    if (!r) { pathResults.hidden = true; return; }
    pathResults.hidden = false;

    if (pathResultRoute) {
      const path = r.route.path;
      const start = path[0];
      const target = path[path.length - 1];
      // startName/targetName are a player's name when picked that way, or already just
      // "(x, y)" when picked by raw coordinates — don't print the coordinates twice.
      const label = (name, cell) => name && name !== `(${cell.x}, ${cell.y})` ? `${name} (${cell.x}, ${cell.y})` : `(${cell.x}, ${cell.y})`;
      pathResultRoute.textContent = `${label(r.startName, start)} → ${label(r.targetName, target)}`;
    }

    if (pathResultHops) pathResultHops.textContent = String(r.route.totalHops);

    const kit = r.route.totalCost;
    if (pathResultCost) {
      pathResultCost.textContent = `${_fmtNum(kit.twigs)} twigs / ${_fmtNum(kit.pebbles)} pebbles / ${_fmtNum(kit.putty)} putty`;
    }

    const takeover = r.route.totalTakeoverCost; // same amount across all 4 resources — see route.js's takeoverCost()
    if (pathResultTakeover) {
      pathResultTakeover.textContent = takeover
        ? `${_fmtNum(takeover.twigs)} each of twigs/pebbles/putty/goo`
        : "—";
    }

    if (pathResultTotal && takeover) {
      pathResultTotal.textContent =
        `${_fmtNum(kit.twigs + takeover.twigs)} twigs / ` +
        `${_fmtNum(kit.pebbles + takeover.pebbles)} pebbles / ` +
        `${_fmtNum(kit.putty + takeover.putty)} putty / ` +
        `${_fmtNum(takeover.goo)} goo`; // kits never cost goo, so goo is takeover-only
    }

    if (pathResultKits) {
      const k = r.route.kitCounts;
      const parts = [];
      if (k[2]) parts.push(`${k[2]}× Regular`);
      if (k[3]) parts.push(`${k[3]}× Mega`);
      if (k[4]) parts.push(`${k[4]}× Ultra`);
      pathResultKits.textContent = parts.length ? parts.join(", ") : "—";
    }

    if (pathProgressReadout) {
      const p = this.renderer?.getRouteProgress();
      if (p && this._effectiveMyUid() != null) {
        pathProgressReadout.hidden = false;
        pathProgressReadout.textContent = `${p.completed}/${p.total} hops taken`
          + (p.blocked ? ` — ${p.blocked} taken by someone else` : "");
      } else {
        pathProgressReadout.hidden = true;
      }
    }
  }

  _setPathStatus(msg) {
    if (this.elements.pathStatus) this.elements.pathStatus.textContent = msg;
  }

  // ── Persistence — one saved route per world ─────────────────────────────────

  _readSavedRoute() {
    if (!this.selectedWorldId) return null;
    try {
      const raw = localStorage.getItem(buildRouteStorageKey(this.selectedWorldId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _saveCurrentRoute() {
    if (!this.currentRoute || !this.selectedWorldId) return;
    try {
      localStorage.setItem(buildRouteStorageKey(this.selectedWorldId), JSON.stringify(this.currentRoute));
      this._routeIsSaved = true;
      this._updatePathSavedBanner();
      this._setPathStatus("Route saved.");
    } catch {
      this._setPathStatus("Couldn't save — local storage may be full or disabled in this browser.");
    }
  }

  _discardSavedRoute() {
    if (!this.selectedWorldId) return;
    localStorage.removeItem(buildRouteStorageKey(this.selectedWorldId));
    this._updatePathSavedBanner();
  }

  _clearRouteDisplay() {
    this.currentRoute = null;
    this._routeIsSaved = false;
    this.renderer?.clearRoute();
    this._renderPathResults();
    this._updatePathSavedBanner();
    this._setPathStatus("");
  }

  _restoreRouteForWorld() {
    const saved = this._readSavedRoute();
    if (saved) this._applyRoute(saved, { fromStorage: true });
    else this._clearRouteDisplay();
  }

  _updatePathSavedBanner() {
    const banner = this.elements.pathSavedBanner;
    if (!banner) return;
    banner.hidden = !this._readSavedRoute() || this._routeIsSaved;
  }

  // ─── Status ─────────────────────────────────────────────────────────────────

  _showStatus(msg) {
    const el = this.elements.statusText;
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  // Gates the map toolbar on world data being loaded. find-home has its own
  // narrower gate — see _updateFindHomeAvailability().
  _setMapControlsEnabled(enabled) {
    this.elements.refreshButton.disabled = !enabled;
    this.elements.searchToggleButton.disabled = !enabled;
    this.elements.searchInput.disabled = !enabled;
    this._enableFilterControls(enabled);
    if (this.elements.pathToggleButton) this.elements.pathToggleButton.disabled = !enabled;
    if (this.elements.measureToggleButton) this.elements.measureToggleButton.disabled = !enabled;
    if (!enabled && this.renderer?.measureMode) this._setMeasureMode(false);
  }

  // Only enabled when View As is set — otherwise there's no "mine" cell to find.
  _updateFindHomeAvailability() {
    const btn = this.elements.findHomeButton;
    if (!btn) return;
    const available = this._effectiveMyUid() != null;
    btn.disabled = !available;
    btn.title = available ? "Jump to home base (H)" : "Set “View as” to find your home base";
    btn.setAttribute("aria-label", btn.title);
  }

  // ─── World picker ───────────────────────────────────────────────────────────

  _setupWorldSelector() {
    this.elements.worldSelect?.addEventListener("change", () => {
      const worldId = this.elements.worldSelect.value;
      if (worldId) this._selectWorld(worldId);
    });
  }

  async _initPolledWorlds() {
    try {
      this.polledWorlds = await this.api.getPolledWorlds();
    } catch (err) {
      this._showStatus(err?.message || "Failed to load the world list.");
      this.polledWorlds = [];
    }

    this._renderWorldOptions();

    if (!this.polledWorlds.length) {
      this._showOverlay(NO_WORLDS_MESSAGE);
      return;
    }

    const stored = localStorage.getItem(SELECTED_WORLD_STORAGE_KEY);
    const storedValid = stored && this.polledWorlds.some((w) => w.uuid === stored);
    const initial = storedValid ? stored : this.polledWorlds[0].uuid;
    await this._selectWorld(initial);
  }

  _renderWorldOptions() {
    const sel = this.elements.worldSelect;
    if (!sel) return;
    sel.innerHTML = this.polledWorlds
      .map((w) => `<option value="${escapeHtml(w.uuid)}">${escapeHtml(w.name || w.uuid)}</option>`)
      .join("");
    sel.disabled = this.polledWorlds.length === 0;
  }

  async _selectWorld(worldId) {
    if (!worldId) return;
    if (this.elements.worldSelect) this.elements.worldSelect.value = worldId;
    if (worldId === this.selectedWorldId) return;

    this.selectedWorldId = worldId;
    localStorage.setItem(SELECTED_WORLD_STORAGE_KEY, worldId);

    this._bumpWorldLoadGeneration();
    this._worldLoaded = false;

    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderer?.clearCells();
    this._renderDetails(null);
    this._clearFilter();
    this._updateSearchEntries();

    this._allianceData = null;
    this.renderer?.setAllianceData(null);

    this._loadViewAsForWorld();

    this._pathStartPick = null;
    this._pathTargetPick = null;
    if (this.elements.pathStartInput) this.elements.pathStartInput.value = "";
    if (this.elements.pathTargetInput) this.elements.pathTargetInput.value = "";
    if (this.elements.pathStartX) this.elements.pathStartX.value = "";
    if (this.elements.pathStartY) this.elements.pathStartY.value = "";
    if (this.elements.pathTargetX) this.elements.pathTargetX.value = "";
    if (this.elements.pathTargetY) this.elements.pathTargetY.value = "";
    document.querySelectorAll('input[name="path-start-mode"][value="player"], input[name="path-target-mode"][value="player"]')
      .forEach((el) => { el.checked = true; });
    this._updatePathModeVisibility("start");
    this._updatePathModeVisibility("target");
    this._clearRouteDisplay();

    this._updateIdentityAvailability();
    this._centerOnStoredHome();

    try {
      await this._loadWorld({ useCache: true });
    } catch { /* _doLoadWorld already surfaced a status message */ }

    this._restoreRouteForWorld();
  }

  // Keeps renderer.myUserId, find-home, View As visibility, the map's
  // alliance-relationship colors, and the on-screen route's progress markers
  // in sync with the current identity.
  _updateIdentityAvailability() {
    const myUid = this._effectiveMyUid();
    this.renderer?.setMyUserId(myUid);
    const viewerAllianceId = myUid != null ? (this._allianceData?.uidToAllianceId.get(myUid) ?? null) : null;
    this.renderer?.setViewerAllianceId(viewerAllianceId);
    this._updateFindHomeAvailability();
    this._updateViewAsUI();
    if (this.currentRoute) this.renderer?.setRoute(this.currentRoute.route, myUid, this.currentRoute.originalOwners);
  }

  // Inverts { "<allianceId>": { name, members: [uid,...], relationships } } (server.py's
  // /api/alliances shape) into the lookups _relationshipTier() needs: which alliance a
  // uid belongs to, and each alliance's own name/relationships.
  _buildAllianceData(raw) {
    const alliancesById = new Map();
    const uidToAllianceId = new Map();
    for (const [allianceId, a] of Object.entries(raw || {})) {
      alliancesById.set(allianceId, { name: a.name, relationships: a.relationships || {} });
      for (const uid of a.members || []) uidToAllianceId.set(uid, allianceId);
    }
    return { alliancesById, uidToAllianceId };
  }

  // ─── Map loading ────────────────────────────────────────────────────────────
  // Loads in two requests — /worldmapv2/terrain (byte-per-cell height map) and
  // /worldmapv2/snapshot (occupied cells) — no chunk-crawling. Unattacked wild
  // camps are reconstructed client-side from pure functions of (x, y, worldid).

  _bumpWorldLoadGeneration() {
    this._worldLoadGeneration++;
    this._worldLoadPromise = null;
  }

  // Shared by _selectWorld and refresh — concurrent callers coalesce onto one fetch.
  _loadWorld(opts = {}) {
    if (this._worldLoadPromise) return this._worldLoadPromise;
    this._worldLoadPromise = this._doLoadWorld(opts).finally(() => {
      this._worldLoadPromise = null;
    });
    return this._worldLoadPromise;
  }

  async _doLoadWorld({ useCache = false, force = false } = {}) {
    if (!this.selectedWorldId || !this.renderer) return;
    const myGeneration = this._worldLoadGeneration;

    const worldid = this.selectedWorldId;
    this.renderer.myUserId = this._effectiveMyUid();

    let terrainBytes = null;
    let snapshot      = null;

    if (useCache && !force) {
      try {
        const [cachedTerrain, cachedSnapshot, cachedAlliances] = await Promise.all([
          sessionCacheGet(buildTerrainCacheKey(worldid)),
          sessionCacheGet(buildSnapshotCacheKey(worldid)),
          sessionCacheGet(buildAllianceCacheKey(worldid)),
        ]);
        if (myGeneration !== this._worldLoadGeneration) return; // superseded mid-fetch
        if (cachedTerrain?.bytes) terrainBytes = cachedTerrain.bytes;
        if (cachedSnapshot?.snapshot) snapshot = cachedSnapshot.snapshot;
        if (cachedAlliances?.alliances) {
          this._allianceData = this._buildAllianceData(cachedAlliances.alliances);
          this.renderer.setAllianceData(this._allianceData);
        }

        if (terrainBytes && snapshot) {
          this.renderer.loadWorld(terrainBytes, snapshot);
          this._terrainBytes = terrainBytes;
          this._worldLoaded  = true;
          this._hideOverlay();
          this._setMapControlsEnabled(true);
          this._updateSearchEntries();
          this._updateFilterCount();
          this._autoFindHome();
          this._updateIdentityAvailability(); // re-derives the viewer's alliance now that data may have just arrived
        }
      } catch { /* no cache, or a read failed — fall through to a normal fetch */ }
    }

    if (!terrainBytes) this._showOverlay("Loading world map...");

    let stepsDone = 0;
    const bump = () => { stepsDone++; this._showProgress("Loading world", stepsDone, 2); };
    this._showProgress("Loading world", 0, 2);

    // Alliances are best-effort — a failure here only means the map falls back to
    // "no relationship data" coloring, not a failure to load the map itself, so it's
    // kept out of the Promise.all below that the map's own load/error state depends on.
    this.api.getAlliances(worldid)
      .then((r) => {
        if (myGeneration !== this._worldLoadGeneration) return;
        this._allianceData = this._buildAllianceData(r.alliances);
        this.renderer?.setAllianceData(this._allianceData);
        this._updateIdentityAvailability();
        sessionCacheSet(buildAllianceCacheKey(worldid), { alliances: r.alliances }).catch(() => {});
      })
      .catch(() => { /* map still works without relationship colors */ });

    let terrainResult, snapshotResult;
    try {
      [terrainResult, snapshotResult] = await Promise.all([
        this.api.getTerrain(worldid).then(r => { bump(); return r; }),
        this.api.getSnapshot(worldid).then(r => { bump(); return r; }),
      ]);
    } catch (err) {
      this._showStatus(err?.message || "Failed to load the world map.");
      if (this._worldLoaded) this._hideOverlay();
      else this._showOverlay(err?.message || "Failed to load the world map.");
      throw err;
    } finally {
      setTimeout(() => this._hideProgress(), 600);
    }

    if (myGeneration !== this._worldLoadGeneration) return;

    let changed = false;

    if (terrainResult.bytes) {
      terrainBytes = terrainResult.bytes;
      changed = true;
      sessionCacheSet(buildTerrainCacheKey(worldid), { bytes: terrainBytes }).catch(() => {});
    }

    if (snapshotResult.snapshot) {
      snapshot = snapshotResult.snapshot;
      changed = true;
      sessionCacheSet(buildSnapshotCacheKey(worldid), { snapshot }).catch(() => {});
    }

    if (!terrainBytes || !snapshot) {
      this._showStatus("Failed to load the world map.");
      this._hideOverlay();
      return;
    }

    if (changed || !this._worldLoaded) {
      this.renderer.loadWorld(terrainBytes, snapshot);
    }

    this._terrainBytes = terrainBytes;
    this._worldLoaded  = true;
    this._hideOverlay();
    this._setMapControlsEnabled(true);
    this._updateSearchEntries();
    this._updateFilterCount();
    this._autoFindHome();
  }

  async _refreshMap() {
    if (!this.selectedWorldId) return;
    this.selectedCell = null;
    try {
      await this._loadWorld({ force: true });
    } catch { /* _doLoadWorld already surfaced a status message */ }
  }

  _autoFindHome() {
    const home = this.renderer?.findHomeCell();
    if (home) {
      this._storeHomePos(home.x, home.y);
      this.renderer.centerOn(home.x, home.y);
    }
  }

  _jumpTo(cx, cy) {
    this.renderer.centerOn(cx, cy);
  }

  _deselectCell() {
    this.selectedCell = null;
    if (this.renderer) this.renderer.selectedCell = null;
    this.renderer?.markDirty();
    this._renderDetails(this.hoveredCell);
  }

  _storeHomePos(x, y) {
    const myUid = this._effectiveMyUid();
    if (myUid == null || !this.selectedWorldId) return;
    const key = buildHomePosKey(myUid, this.selectedWorldId);
    localStorage.setItem(key, JSON.stringify({ x, y }));
  }

  _centerOnStoredHome() {
    if (!this.renderer) return;
    const myUid = this._effectiveMyUid();
    if (myUid != null && this.selectedWorldId) {
      const key = buildHomePosKey(myUid, this.selectedWorldId);
      try {
        const stored = JSON.parse(localStorage.getItem(key) || "null");
        if (stored?.x != null && stored?.y != null) {
          this.renderer.centerOn(stored.x, stored.y);
          return;
        }
      } catch { /* ignore */ }
    }
    this.renderer.centerOn(MR2.mapWidth / 2, MR2.mapHeight / 2);
  }

  // ─── Progress UI ─────────────────────────────────────────────────────────────

  _showProgress(message, done, total) {
    const { loadProgress, loadProgressBar, loadProgressText } = this.elements;
    if (!loadProgress) return;
    loadProgress.hidden = false;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (loadProgressBar) loadProgressBar.style.width = `${pct}%`;
    if (loadProgressText) loadProgressText.textContent = `${message}... (${pct}%)`;
  }

  _hideProgress() {
    if (this.elements.loadProgress) this.elements.loadProgress.hidden = true;
  }

  // innerHTML (not textContent) so a message can include a link; callers always pass a trusted string.
  _showOverlay(html) {
    const overlay = this.elements.mapOverlay;
    if (!overlay) return;
    if (this.elements.mapOverlayMessage) this.elements.mapOverlayMessage.innerHTML = html;
    overlay.hidden = false;
  }

  _hideOverlay() {
    if (this.elements.mapOverlay) this.elements.mapOverlay.hidden = true;
  }

  // ─── Cell details panel — hover previews, click pins it open ───────────────

  _renderDetails(cell) {
    const panel    = this.elements.detailPanel;
    const title    = this.elements.detailsTitle;
    const avatar   = this.elements.detailsAvatar;
    const content  = this.elements.detailsContent;
    const closeBtn = this.elements.detailsCloseButton;
    if (!title || !content) return;

    // Only the player-cell branch below ever shows one — every other return path
    // (no selection, water, wild monster) hides it first.
    if (avatar) avatar.hidden = true;

    if (!cell) {
      if (panel) panel.hidden = true;
      title.textContent = "No selection";
      content.innerHTML = "Hover or click a cell to inspect it.";
      return;
    }

    if (panel) panel.hidden = false;
    if (closeBtn) closeBtn.hidden = !this.selectedCell;

    const { x, y, i, uid, b, n, l, dm, d, lo, p, t, mine, f, r } = cell;

    const rawHeight    = i ?? 0;
    const cellIsWater  = isWater(rawHeight);
    const terrainLabel = getTerrainLabel(rawHeight);

    // Altitude in metres above sea level (game displays height - 100).
    // Average altitude hardcoded to 125 in the original client (GLOBAL._averageAltitude).
    const ALT_AVG  = 125;
    const altM     = rawHeight - 100;
    const altStr   = cellIsWater ? `${altM}m (impassable)` : `${altM}m`;
    const terrainRow = `<div class="detail-row"><span>Terrain</span><span>${terrainLabel}, ${altStr}</span></div>`;

    // ── Water / bare terrain ──────────────────────────────────────────────────
    if (cellIsWater || (uid === undefined && b === undefined)) {
      const label = cellIsWater ? "Water / Impassable" : "Terrain";
      title.textContent = `${label} (${x}, ${y})`;
      content.innerHTML = `
        <div class="detail-row"><span>Coords</span><span>${x}, ${y}</span></div>
        ${terrainRow}
      `;
      return;
    }

    // ── Wild monster cell ─────────────────────────────────────────────────────
    if (uid === 0) {
      title.textContent = `Wild: ${escapeHtml(n || "?")} (${x}, ${y})`;
      content.innerHTML = `
        <div class="detail-row"><span>Coords</span><span>${x}, ${y}</span></div>
        <div class="detail-row"><span>Tribe</span><span>${escapeHtml(n || "Unknown")}</span></div>
        <div class="detail-row"><span>Level</span><span>${l ?? "?"}</span></div>
        ${terrainRow}
        ${dm > 0 ? `<div class="detail-row detail-damage"><span>Damage</span><span>${dm}%</span></div>` : ""}
        ${d      ? `<div class="detail-row detail-damage"><span>Status</span><span>Destroyed</span></div>` : ""}
      `;
      return;
    }

    // ── Player cell ───────────────────────────────────────────────────────────
    const isMine      = mine === 1;
    const isHome      = b === MR2.cellTypes.HOMECELL;
    const baseType    = isHome ? "Home Base" : b === MR2.cellTypes.OUTPOST ? "Outpost" : "Base";
    const owner       = isMine ? "My" : "";
    const isOnline    = lo === 1;
    const isProtected = p === 1;

    // Altitude bonuses — home base always 0 (by game design), outposts use formula.
    // Tower bonus = height*100/125 - 100  (higher ground → bonus)
    // Resource bonus = 100*125/height - 100 (lower ground → bonus)
    const towerBonus    = isHome || rawHeight === 0 ? 0 : Math.round(rawHeight * 100 / ALT_AVG - 100);
    const resourceBonus = isHome || rawHeight === 0 ? 0 : Math.round(100 * ALT_AVG / rawHeight - 100);
    const showBonuses   = !isHome && (towerBonus !== 0 || resourceBonus !== 0);

    const bonusRow = (label, pct) => {
      if (pct === 0) return `<div class="detail-row"><span>${label}</span><span>none</span></div>`;
      const cls = pct > 0 ? "detail-bonus" : "detail-penalty";
      return `<div class="detail-row ${cls}"><span>${label}</span><span>${pct > 0 ? "+" : ""}${pct}%</span></div>`;
    };

    const flingerLv    = Number(f) || 0;
    const flingerRange = _flingerRangeOf({ f: flingerLv, b: isHome ? MR2.cellTypes.HOMECELL : MR2.cellTypes.OUTPOST });

    // Outpost count: scan loaded cells for same uid with b===3
    const outpostCount = this._countPlayerOutposts(uid);

    // Truce time remaining
    const truceStr = t
      ? (() => {
          const remaining = t - Math.floor(Date.now() / 1000);
          if (remaining <= 0) return "";
          const h = Math.floor(remaining / 3600);
          const m = Math.floor((remaining % 3600) / 60);
          return `${h}h ${m}m`;
        })()
      : "";

    // Resources { r1, r2, r3, r4, r1max, r2max, r3max, r4max }
    const hasRes = r && typeof r === "object";
    const res = (key, name) => {
      if (!hasRes || r[key] === undefined) return "";
      return `<div class="detail-row"><span>${name}</span><span>${_fmtNum(r[key])} / ${_fmtNum(r[key + "max"])}</span></div>`;
    };

    // Alliance data is best-effort (see _doLoadWorld) — "?" means we don't know either
    // way (not loaded yet, or the fetch failed), distinct from a confirmed "None".
    let allianceLabel;
    if (!this._allianceData) {
      allianceLabel = "?";
    } else {
      const allianceId = this._allianceData.uidToAllianceId.get(uid);
      allianceLabel = allianceId == null
        ? "None"
        : escapeHtml(this._allianceData.alliancesById.get(allianceId)?.name || "Unknown alliance");
    }

    // Coords already have their own detail row below, so the title doesn't repeat them.
    if (avatar) {
      const avatarUrl = cell.pic_square || cell.im;
      if (avatarUrl) {
        avatar.src = avatarUrl;
        avatar.alt = n || "";
        avatar.hidden = false;
      } else {
        avatar.hidden = true;
      }
    }

    // Outposts only — a home base is already where you'd be jumping to.
    const homeCell = !isHome ? this.renderer?.getHomeCellForUid(uid) : null;

    title.textContent = `${owner} ${baseType}: ${escapeHtml(n || "?")}`;
    content.innerHTML = `
      <div class="detail-row"><span>Coords</span><span>${x}, ${y}</span></div>
      <div class="detail-row"><span>Player</span><span>${n
        ? `<span class="detail-player-name" data-uid="${uid}" data-name="${escapeHtml(n)}" title="Click to filter/highlight this player" tabindex="0" role="button">${escapeHtml(n)}</span>`
        : "Unknown"}</span></div>
      <div class="detail-row"><span>Alliance</span><span>${allianceLabel}</span></div>
      <div class="detail-row"><span>Type</span><span>${escapeHtml(baseType)}</span></div>
      ${homeCell ? `
        <div class="detail-row detail-action-row">
          <span class="detail-go-home-link" data-x="${homeCell.x}" data-y="${homeCell.y}" title="Pan the map to this player's home base" tabindex="0" role="button">Go to Home →</span>
        </div>
      ` : ""}
      <div class="detail-row"><span>Level</span><span>${l ?? "?"}</span></div>
      ${terrainRow}
      ${outpostCount > 0 ? `<div class="detail-row"><span>Outposts</span><span>${this._formatOutpostCount(outpostCount)}</span></div>` : ""}
      ${showBonuses ? bonusRow("Tower bonus",    towerBonus)    : ""}
      ${showBonuses ? bonusRow("Resource bonus", resourceBonus) : ""}
      ${flingerLv > 0 ? `<div class="detail-row"><span>Flinger</span><span>Lv ${flingerLv} — ${flingerRange} cell reach</span></div>` : ""}
      ${hasRes ? `<div class="detail-divider">Resources (this base's stockpile / cap)</div>` : ""}
      ${res("r1", "Twigs")}
      ${res("r2", "Pebbles")}
      ${res("r3", "Putty")}
      ${res("r4", "Goo")}
      ${dm > 0 ? `<div class="detail-row detail-damage"><span>Damage</span><span>${dm}%</span></div>` : ""}
      ${d        ? `<div class="detail-row detail-damage"><span>Status</span><span>Destroyed</span></div>` : ""}
      ${isOnline ? `<div class="detail-row detail-online"><span>Status</span><span>Online / Under attack</span></div>` : ""}
      ${isProtected ? `<div class="detail-row detail-protected"><span>Protection</span><span>Active</span></div>` : ""}
      ${truceStr ? `<div class="detail-row detail-truce"><span>Truce</span><span>${escapeHtml(truceStr)} remaining</span></div>` : ""}
    `;
  }

  _countPlayerOutposts(uid) {
    if (!this.renderer || !uid) return 0;
    let count = 0;
    for (const cell of this.renderer.cells.values()) {
      if (cell.uid === uid && cell.b === MR2.cellTypes.OUTPOST) count++;
    }
    return count;
  }

  _formatOutpostCount(count) {
    return String(count);
  }

  // ─── Search ───────────────────────────────────────────────────────────────────

  // Position a fixed-positioned dropdown below its anchor element.
  // Must be called before unhiding the dropdown so the layout is correct.
  _positionDropdown(dropdown, anchor) {
    const rect = anchor.getBoundingClientRect();
    dropdown.style.top   = `${rect.bottom + 4}px`;
    dropdown.style.left  = `${rect.left}px`;
    dropdown.style.width = `${rect.width}px`;
  }

  // Same idea as _positionDropdown(), but for a popover with its own preferred
  // width rather than one that should match its anchor — clamped so it never
  // runs off either edge of a narrow (phone-width) viewport. `align` picks
  // which edge hugs the anchor when there's room, same as the old CSS anchoring.
  _positionPopover(popover, anchor, preferredWidth, { align = "left" } = {}) {
    const margin = 12;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(preferredWidth, window.innerWidth - margin * 2);
    let left = align === "right" ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    popover.style.top   = `${rect.bottom + 8}px`;
    popover.style.left  = `${left}px`;
    popover.style.width = `${width}px`;
  }

  _updateSearchEntries() {
    if (!this.renderer) return;
    this.searchEntries = this.renderer.getPlayerCells();
  }

  _onSearchInput() {
    const query = this.elements.searchInput?.value?.trim().toLowerCase() ?? "";
    const results = this.elements.searchResults;
    if (!results) return;

    if (!query) {
      results.hidden = true;
      return;
    }

    // One entry per player — jumps to home if loaded, else nearest outpost to their cluster centroid.
    const byPlayer = new Map();  // uid → { name, home, outposts[] }
    for (const cell of this.renderer.cells.values()) {
      if (!(cell.uid > 0 && cell.n)) continue;
      if (!cell.n.toLowerCase().includes(query)) continue;

      let entry = byPlayer.get(cell.uid);
      if (!entry) {
        entry = { uid: cell.uid, name: cell.n, home: null, outposts: [] };
        byPlayer.set(cell.uid, entry);
      }
      if (cell.b === MR2.cellTypes.HOMECELL)      entry.home = cell;
      else if (cell.b === MR2.cellTypes.OUTPOST)  entry.outposts.push(cell);
    }

    // Resolve each player to a single "jump target" cell + display metadata
    const matches = [];
    for (const entry of byPlayer.values()) {
      if (entry.home) {
        matches.push({
          name:    entry.name,
          cell:    entry.home,
          hasHome: true,
          outpostCount: entry.outposts.length,
        });
      } else if (entry.outposts.length > 0) {
        // Outpost closest to the centroid = middle of their cluster
        const cx = entry.outposts.reduce((s, o) => s + o.x, 0) / entry.outposts.length;
        const cy = entry.outposts.reduce((s, o) => s + o.y, 0) / entry.outposts.length;
        let best = entry.outposts[0];
        let bestD = Infinity;
        for (const op of entry.outposts) {
          const d = (op.x - cx) ** 2 + (op.y - cy) ** 2;
          if (d < bestD) { bestD = d; best = op; }
        }
        matches.push({
          name:    entry.name,
          cell:    best,
          hasHome: false,
          outpostCount: entry.outposts.length,
        });
      }
    }

    // Sort: home-known players first, then alphabetically
    matches.sort((a, b) => {
      if (a.hasHome !== b.hasHome) return a.hasHome ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    this.searchMatches = matches.slice(0, SEARCH_RESULT_LIMIT);

    if (!this.searchMatches.length) {
      results.innerHTML = `<div class="search-result-item muted">No results</div>`;
      this._positionDropdown(results, this.elements.searchInput);
      results.hidden = false;
      return;
    }

    results.innerHTML = this.searchMatches
      .map((m, i) => {
        const badge = m.hasHome
          ? `<span class="search-result-type">Home</span>`
          : `<span class="search-result-type search-result-type--partial">~ ${m.outpostCount} outpost${m.outpostCount === 1 ? "" : "s"}</span>`;
        return `
          <button class="search-result-item" data-index="${i}" type="button">
            ${escapeHtml(m.name)} ${badge}
            <span class="search-result-coords">(${m.cell.x}, ${m.cell.y})</span>
          </button>`;
      })
      .join("");

    this._positionDropdown(results, this.elements.searchInput);
    results.hidden = false;

    results.querySelectorAll(".search-result-item[data-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx   = parseInt(btn.dataset.index, 10);
        const match = this.searchMatches[idx];
        if (match) {
          this._jumpTo(match.cell.x, match.cell.y);
          this.selectedCell = match.cell;
          this.renderer.selectedCell = match.cell;
          this.renderer.markDirty();
          this._renderDetails(match.cell);
          results.hidden = true;
          this.elements.searchInput.value = match.name;
        }
      });
    });
  }

  // ─── Measuring tool (ruler) ─────────────────────────────────────────────────
  // Entirely client-side and in-memory — see MapRenderer's measureMode/measurements.
  // Nothing here is persisted, so a page refresh clears every ruler, by design.

  _setupMeasureTool() {
    const { measureToggleButton, measureClearButton } = this.elements;
    if (!measureToggleButton) return;

    measureToggleButton.addEventListener("click", () => this._toggleMeasureMode());
    measureClearButton?.addEventListener("click", () => this.renderer?.clearMeasurements());

    if (this.renderer) {
      this.renderer.onMeasurementsChanged = () => this._updateMeasureClearAvailability();
    }
    this._updateMeasureClearAvailability();
  }

  _toggleMeasureMode() {
    if (!this.renderer || this.elements.measureToggleButton?.disabled) return;
    this._setMeasureMode(!this.renderer.measureMode);
  }

  _setMeasureMode(on) {
    if (!this.renderer) return;
    this.renderer.setMeasureMode(on);
    const { measureToggleButton } = this.elements;
    measureToggleButton?.setAttribute("aria-expanded", String(on));
    measureToggleButton?.classList.toggle("icon-button--active", on);
    measureToggleButton?.setAttribute(
      "title",
      on ? "Measuring — click two points or drag a line (M to stop, Esc to cancel)" : "Measure distance (M)",
    );
  }

  _updateMeasureClearAvailability() {
    const btn = this.elements.measureClearButton;
    if (!btn) return;
    btn.disabled = !(this.renderer?.measurements?.length);
  }

  // ─── Avatar lightbox ────────────────────────────────────────────────────────

  _setupAvatarLightbox() {
    const { detailsAvatar, avatarLightbox, avatarLightboxImg } = this.elements;
    if (!detailsAvatar || !avatarLightbox || !avatarLightboxImg) return;

    detailsAvatar.addEventListener("click", () => this._openAvatarLightbox(detailsAvatar.src));
    avatarLightbox.addEventListener("click", () => this._closeAvatarLightbox());
  }

  _openAvatarLightbox(src) {
    const { avatarLightbox, avatarLightboxImg } = this.elements;
    if (!avatarLightbox || !avatarLightboxImg || !src) return;
    avatarLightboxImg.src = src;
    avatarLightbox.hidden = false;
  }

  _closeAvatarLightbox() {
    const { avatarLightbox } = this.elements;
    if (avatarLightbox) avatarLightbox.hidden = true;
  }

  // ─── Filter ──────────────────────────────────────────────────────────────────

  _setupFilterPanel() {
    const { filterToggleButton, filterPanel, filterPlayerInput, filterClearButton } = this.elements;

    filterToggleButton?.addEventListener("click", () => {
      this.filterOpen = !this.filterOpen;
      filterPanel.hidden = !this.filterOpen;
      filterToggleButton.setAttribute("aria-expanded", String(this.filterOpen));
      if (this.filterOpen) {
        filterPlayerInput?.focus();
      } else {
        if (this.elements.filterPlayerResults) this.elements.filterPlayerResults.hidden = true;
      }
    });

    filterPlayerInput?.addEventListener("input", () => {
      this._applyFilter();
      this._showFilterPlayerSuggestions();
    });

    // Clicking anywhere on the tags area (not on a chip) focuses the text input
    document.getElementById("filter-player-tags-area")?.addEventListener("click", (e) => {
      if (!e.target.closest(".filter-player-chip")) filterPlayerInput?.focus();
    });

    // Hide suggestions when input loses focus (small delay so click registers)
    filterPlayerInput?.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.elements.filterPlayerResults) this.elements.filterPlayerResults.hidden = true;
      }, 150);
    });

    filterClearButton?.addEventListener("click", () => this._clearFilter());

    // Delegate all checkbox changes inside the filter panel
    filterPanel?.addEventListener("change", (e) => {
      if (e.target.type === "checkbox") this._applyFilter();
    });

    this._setupBonusRanges();

    // Close filter panel if user clicks outside.
    // filterPlayerResults is now a body-level portal so check it separately.
    document.addEventListener("click", (e) => {
      if (!this.filterOpen) return;
      const bar = document.querySelector(".map-tool-bar");
      const fpResults = this.elements.filterPlayerResults;
      if (bar && !bar.contains(e.target) && !fpResults?.contains(e.target)) {
        this.filterOpen = false;
        if (filterPanel) filterPanel.hidden = true;
        if (fpResults) fpResults.hidden = true;
        filterToggleButton?.setAttribute("aria-expanded", "false");
      }
    }, true);
  }

  /** The pink default until the player picks something else for this uid — see the chip's color input. */
  _colorForFilterPlayer(uid) {
    return this._filterPlayerColors.get(uid) || DEFAULT_FILTER_COLOR;
  }

  /** Pins a player to the multi-player filter — from the autocomplete dropdown or the detail panel's clickable name. */
  _addPlayerToFilter(uid, name) {
    if (!uid) return;
    this._filterPlayers.set(uid, name);
    this._renderFilterPlayerChips();
    this._applyFilter();
  }

  _renderFilterPlayerChips() {
    const area = document.getElementById("filter-player-tags-area");
    const input = this.elements.filterPlayerInput;
    if (!area || !input) return;

    // Remove existing chips, leave the input intact
    area.querySelectorAll(".filter-player-chip").forEach((el) => el.remove());

    for (const [uid, name] of this._filterPlayers) {
      const color = this._colorForFilterPlayer(uid);
      const chip = document.createElement("span");
      chip.className = "filter-player-chip";
      chip.innerHTML =
        `<span class="filter-player-chip-name" title="Click to change ${escapeHtml(name)}'s color" tabindex="0" role="button">` +
          `<span class="filter-player-chip-swatch" style="background:${color}"></span>${escapeHtml(name)}` +
        `</span>` +
        `<input type="color" class="filter-player-chip-color-input" value="${color}" aria-label="Color for ${escapeHtml(name)}" tabindex="-1">` +
        `<button class="filter-player-chip-remove" type="button" aria-label="Remove ${escapeHtml(name)}" data-uid="${uid}">×</button>`;
      area.insertBefore(chip, input);

      const nameEl = chip.querySelector(".filter-player-chip-name");
      const colorInput = chip.querySelector(".filter-player-chip-color-input");
      const openPicker = () => colorInput.click();
      nameEl.addEventListener("click", openPicker);
      nameEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
      });
      colorInput.addEventListener("input", () => {
        this._filterPlayerColors.set(uid, colorInput.value);
        _saveFilterColors(this._filterPlayerColors);
        nameEl.querySelector(".filter-player-chip-swatch").style.background = colorInput.value;
        this._applyFilter();
      });

      chip.querySelector(".filter-player-chip-remove").addEventListener("click", () => {
        this._filterPlayers.delete(uid);
        this._renderFilterPlayerChips();
        this._applyFilter();
      });
    }

    input.placeholder = this._filterPlayers.size > 0 ? "Add more…" : "Type to add players…";
  }

  _showFilterPlayerSuggestions() {
    const { filterPlayerInput, filterPlayerResults } = this.elements;
    if (!filterPlayerInput || !filterPlayerResults) return;

    const query = filterPlayerInput.value.trim().toLowerCase();
    if (!query) {
      filterPlayerResults.hidden = true;
      return;
    }

    // Exclude players already in the chip list
    const matches = this.searchEntries
      .filter((c) => c.n && c.n.toLowerCase().includes(query) && !this._filterPlayers.has(c.uid))
      .slice(0, 20);

    if (!matches.length) {
      filterPlayerResults.hidden = true;
      return;
    }

    filterPlayerResults.innerHTML = matches
      .map((c) => `<button class="search-result-item" data-name="${escapeHtml(c.n)}" data-uid="${c.uid}" type="button">${escapeHtml(c.n)}</button>`)
      .join("");

    this._positionDropdown(filterPlayerResults, filterPlayerInput);
    filterPlayerResults.hidden = false;

    filterPlayerResults.querySelectorAll(".search-result-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._addPlayerToFilter(Number(btn.dataset.uid) || null, btn.dataset.name);
        filterPlayerInput.value = "";
        filterPlayerResults.hidden = true;
      });
    });
  }

  // ── Bonus range sliders ────────────────────────────────────────────────────

  _setupBonusRanges() {
    const configs = [
      {
        minId: "tower-bonus-min",    maxId: "tower-bonus-max",
        fillId: "tower-bonus-fill",
        minLabelId: "tower-bonus-min-label", maxLabelId: "tower-bonus-max-label",
      },
      {
        minId: "resource-bonus-min", maxId: "resource-bonus-max",
        fillId: "resource-bonus-fill",
        minLabelId: "resource-bonus-min-label", maxLabelId: "resource-bonus-max-label",
      },
    ];

    for (const cfg of configs) {
      const minEl      = document.getElementById(cfg.minId);
      const maxEl      = document.getElementById(cfg.maxId);
      const fillEl     = document.getElementById(cfg.fillId);
      const minLabelEl = document.getElementById(cfg.minLabelId);
      const maxLabelEl = document.getElementById(cfg.maxLabelId);
      if (!minEl || !maxEl) continue;

      const update = () => {
        this._updateRangeFill(minEl, maxEl, fillEl, minLabelEl, maxLabelEl);
        this._applyFilter();
      };

      // Bring the dragged slider to the front so its thumb is always reachable
      minEl.addEventListener("pointerdown", () => { minEl.style.zIndex = "2"; maxEl.style.zIndex = "1"; });
      maxEl.addEventListener("pointerdown", () => { maxEl.style.zIndex = "2"; minEl.style.zIndex = "1"; });

      minEl.addEventListener("input", update);
      maxEl.addEventListener("input", update);

      // Initial fill
      this._updateRangeFill(minEl, maxEl, fillEl, minLabelEl, maxLabelEl);
    }
  }

  _updateRangeFill(minEl, maxEl, fillEl, minLabelEl, maxLabelEl) {
    const lo = parseInt(minEl.value);
    const hi = parseInt(maxEl.value);
    const rangeMin = parseInt(minEl.min);
    const rangeMax = parseInt(maxEl.max);
    const span = rangeMax - rangeMin;

    const leftPct  = (lo - rangeMin) / span * 100;
    const rightPct = (hi - rangeMin) / span * 100;

    if (fillEl) {
      fillEl.style.left  = `${leftPct}%`;
      fillEl.style.width = `${Math.max(0, rightPct - leftPct)}%`;
      const active = lo > rangeMin || hi < rangeMax;
      fillEl.classList.toggle("filter-range-fill--active", active);
    }

    const fmt = (n) => (n >= 0 ? "+" : "") + n + "%";
    if (minLabelEl) minLabelEl.textContent = fmt(lo);
    if (maxLabelEl) maxLabelEl.textContent = fmt(hi);
  }

  _readBonusRange(minId, maxId) {
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    if (!minEl || !maxEl) return null;
    const lo = parseInt(minEl.value), hi = parseInt(maxEl.value);
    const active = lo > parseInt(minEl.min) || hi < parseInt(maxEl.max);
    return active ? { min: lo, max: hi } : null;
  }

  _resetBonusRange(minId, maxId, fillId, minLabelId, maxLabelId) {
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    if (minEl) minEl.value = minEl.min;
    if (maxEl) maxEl.value = maxEl.max;
    this._updateRangeFill(
      minEl, maxEl,
      document.getElementById(fillId),
      document.getElementById(minLabelId),
      document.getElementById(maxLabelId),
    );
  }

  // ── Filter apply / clear ───────────────────────────────────────────────────

  _applyFilter() {
    // Uid set takes precedence; fall back to free-text substring when no players pinned
    const filterPlayerUids = this._filterPlayers.size > 0 ? new Set(this._filterPlayers.keys()) : null;
    const filterPlayerColors = filterPlayerUids
      ? new Map([...this._filterPlayers.keys()].map((uid) => [uid, this._colorForFilterPlayer(uid)]))
      : null;
    const playerName = filterPlayerUids ? "" : (this.elements.filterPlayerInput?.value ?? "").trim().toLowerCase();

    const baseTypes = new Set();
    document.querySelectorAll("#filter-base-options input[type=checkbox]:checked")
      .forEach((cb) => baseTypes.add(cb.value));

    const terrainTypes = new Set();
    document.querySelectorAll("#filter-terrain-options input[type=checkbox]:checked")
      .forEach((cb) => terrainTypes.add(cb.value));

    const towerBonusRange    = this._readBonusRange("tower-bonus-min",    "tower-bonus-max");
    const resourceBonusRange = this._readBonusRange("resource-bonus-min", "resource-bonus-max");

    const flingerLevels = new Set();
    document.querySelectorAll("#filter-flinger-options input[type=checkbox]:checked")
      .forEach((cb) => flingerLevels.add(Number(cb.value)));

    const hasAny = playerName || filterPlayerUids || baseTypes.size || terrainTypes.size || towerBonusRange || resourceBonusRange || flingerLevels.size;
    this.renderer?.setFilter(hasAny ? { playerName, filterPlayerUids, filterPlayerColors, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange, flingerLevels } : null);

    this._updateFilterCount();
  }

  _clearFilter() {
    if (this.elements.filterPlayerInput) this.elements.filterPlayerInput.value = "";
    if (this.elements.filterPlayerResults) this.elements.filterPlayerResults.hidden = true;
    this._filterPlayers = new Map();
    this._renderFilterPlayerChips();
    document.querySelectorAll("#filter-base-options input[type=checkbox], #filter-terrain-options input[type=checkbox], #filter-flinger-options input[type=checkbox]")
      .forEach((cb) => { cb.checked = false; });
    this._resetBonusRange("tower-bonus-min",    "tower-bonus-max",    "tower-bonus-fill",    "tower-bonus-min-label",    "tower-bonus-max-label");
    this._resetBonusRange("resource-bonus-min", "resource-bonus-max", "resource-bonus-fill", "resource-bonus-min-label", "resource-bonus-max-label");
    this.renderer?.setFilter(null);
    this._updateFilterCount();
  }

  _updateFilterCount() {
    const el = this.elements.filterMatchCount;
    if (!el || !this.renderer) return;
    const count = this.renderer.countFilterMatches();
    const active = this.renderer._hasActiveFilter();
    el.textContent = active ? `${count.toLocaleString()} cells highlighted` : "No filter active";
  }

  _enableFilterControls(enabled) {
    const { filterToggleButton } = this.elements;
    if (filterToggleButton) filterToggleButton.disabled = !enabled;
  }
}
