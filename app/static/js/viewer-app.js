import { ApiClient } from "./api-client.js";
import { MapRenderer } from "./map-renderer.js";
import {
  MR2,
  STABLE_VIEWER_CONFIG,
  SELECTED_WORLD_STORAGE_KEY,
  SEARCH_RESULT_LIMIT,
  buildTokenStorageKey,
  buildTerrainCacheKey,
  buildSnapshotCacheKey,
  buildHomePosKey,
  buildRouteStorageKey,
  buildViewAsKey,
  cellKey,
  escapeHtml,
  getTerrainLabel,
  isWater,
  sessionCacheGet,
  sessionCacheSet,
  setViewerConfig,
} from "./shared.js";
import { findRoute, wrappedHexDistance } from "./route.js";

// MR3 sibling viewer, linked when a logged-in account's world isn't a polled MR2 world.
const OTHER_VIEWER_URL = "https://bymr-maproom3-viewer.chibbluffy.fyi/";
const NOT_ON_MR2_MESSAGE =
  `This account isn't on a Map Room 2 world. Please make sure it is on an ` +
  `upgraded map room, or try the other map viewer: ` +
  `<a href="${OTHER_VIEWER_URL}" target="_blank" rel="noopener">${OTHER_VIEWER_URL}</a>`;

const NO_WORLDS_MESSAGE = "No worlds have been polled yet — check back in a few minutes.";

// Shown when a base's resources are hidden because canEnrich is false.
const LOGIN_PROMPT_HTML = `
  <div class="detail-login-prompt">
    <p class="detail-login-prompt-text">
      Log in to see this base's live resource stockpile. Your BYM credentials
      go straight from your browser to the game server — never to this app's
      own server.
    </p>
    <button class="secondary-button detail-login-button" type="button">Log in</button>
  </div>
`;

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

// Resolves a Path target's cell: closest outpost to the other endpoint (home
// bases can't be taken over — see route.js's isPassable()). Null if no outposts.
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

// Signed compact number: 1234567 -> "+1.2M", -500 -> "-500", 0 -> "0". Unlike
// _fmtNum(), negatives aren't clamped — a leaderboard delta can be real.
function _fmtSigned(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return sign + _fmtNum(Math.abs(v));
}

// "+5 / -3" — gains and losses shown separately, never netted.
function _fmtGainLoss(gain, loss) {
  const g = Number(gain) || 0, l = Number(loss) || 0;
  const gainHtml = g > 0 ? `<span class="activity-gain">+${_fmtNum(g)}</span>` : `<span class="muted">+0</span>`;
  const lossHtml = l > 0 ? `<span class="activity-loss">-${_fmtNum(l)}</span>` : `<span class="muted">-0</span>`;
  return `${gainHtml} / ${lossHtml}`;
}

// Signed number, colour-coded — for a plain net delta (unlike _fmtGainLoss()).
function _fmtSignedCls(n) {
  const v = Number(n) || 0;
  const cls = v > 0 ? "activity-gain" : v < 0 ? "activity-loss" : "muted";
  return `<span class="${cls}">${_fmtSigned(v)}</span>`;
}

// Generic sort for leaderboard tables — {field, dir}. "name" sorts as text, else numeric.
function _sortRows(rows, { field, dir }) {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (field === "name") return mul * String(a.name || "").localeCompare(String(b.name || ""));
    return mul * ((Number(a[field]) || 0) - (Number(b[field]) || 0));
  });
}

/** Reflects a table's sort state onto its <th data-sort> elements (arrow via CSS ::after). */
function _updateSortHeaders(table, { field, dir }) {
  if (!table) return;
  table.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === field;
    th.toggleAttribute("data-sort-active", active);
    th.dataset.sortDir = active ? (dir === "asc" ? "▲" : "▼") : "";
  });
}

function _fmtRelTime(unixSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Human-readable one-liner for a grouped world_events row (db.py's list_events_grouped()).
function _describeEventGroup(g) {
  const place = g.base_type === MR2.cellTypes.HOMECELL ? "home base"
    : g.base_type === MR2.cellTypes.OUTPOST ? "outposts" : "bases";
  const placeSingular = g.base_type === MR2.cellTypes.HOMECELL ? "home base"
    : g.base_type === MR2.cellTypes.OUTPOST ? "outpost" : "base";
  const n = g.count;
  switch (g.event_type) {
    case "TAKEOVER":
      return n === 1
        ? `${escapeHtml(g.new_name || "Someone")} took ${escapeHtml(g.old_name || "a player")}'s ${placeSingular}`
        : `${escapeHtml(g.new_name || "Someone")} took ${n} ${place} from ${escapeHtml(g.old_name || "a player")}`;
    case "CLAIMED_FROM_WILD":
      return n === 1
        ? `${escapeHtml(g.new_name || "Someone")} claimed a wild tribe camp`
        : `${escapeHtml(g.new_name || "Someone")} claimed ${n} wild tribe camps`;
    case "RECYCLED":
      return n === 1
        ? `${escapeHtml(g.old_name || "A player")}'s ${placeSingular} was recycled`
        : `${escapeHtml(g.old_name || "A player")} recycled ${n} ${place}`;
    default:
      return escapeHtml(g.event_type);
  }
}

// ─── ViewerApp ────────────────────────────────────────────────────────────────

export class ViewerApp {
  constructor() {
    this.api = null;
    this.config = null;
    this.session = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.searchEntries = [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.filterOpen = false;
    this._filterPlayers = new Map();  // uid → name; drives multi-player highlight

    // ── World picker state ─────────────────────────────────────────────────
    this.polledWorlds = [];      // [{uuid, name, map_version, player_count, last_polled_at}, ...] from /api/worlds
    this.selectedWorldId = null; // uuid of the world currently on screen
    this.canEnrich = false;      // true when selectedWorldId === session.map.worldid
    this._hadStoredWorldSelection = false;

    // ── World-load state ───────────────────────────────────────────────────
    this._worldLoaded      = false;
    this._terrainBytes     = null;
    this._worldLoadPromise = null;
    this._worldLoadGeneration = 0; // bumped on world switch; a stale in-flight load discards its result
    this._enrichToken = 0; // bumped per cell click so a stale getarea reply can't clobber a later selection

    // ── "View as" — client-only identity, no login ────────────────────────
    this._viewAs = null; // {uid, name} | null

    // ── Path tool (route planner) ──────────────────────────────────────────
    this._pathStartPick  = null;
    this._pathTargetPick = null;
    this.currentRoute     = null; // { route, originalOwners, options, startName, targetName } | null
    this._routeIsSaved    = false;

    // ── Activity modal ──────────────────────────────────────────────────────
    this._activityTab = "events"; // "events" | "activity-leaderboard" | "empire-leaderboard" | "inactive"
    this._eventsCursor = null;
    this._eventsExhausted = false;
    // Both leaderboards fetch once per modal-open, unpaginated; sort/filter/page client-side.
    this._activityLbRows = [];
    this._activityLbSort = { field: "net_day", dir: "desc" };
    this._activityLbShown = 50; // how many of the sorted/filtered rows are currently rendered — "View more" grows this
    this._empireLbRows = [];
    this._empireLbSort = { field: "total_empirevalue", dir: "desc" };
    this._empireLbShown = 50;

    this.elements = {
      appRoot:            document.getElementById("app"),
      worldSelect:        document.getElementById("world-select"),
      emailInput:         document.getElementById("email-input"),
      passwordInput:      document.getElementById("password-input"),
      loginForm:          document.getElementById("login-form"),
      loginButton:        document.getElementById("login-button"),
      logoutButton:       document.getElementById("logout-button"),
      sessionName:        document.getElementById("session-name"),
      sessionStatus:      document.getElementById("session-status"),
      sessionWorld:       document.getElementById("session-world"),
      sessionTriggerButton: document.getElementById("session-trigger-button"),
      sessionTriggerLabel: document.getElementById("session-trigger-label"),
      sessionPopover:       document.getElementById("session-popover"),
      detailPanel:        document.getElementById("cell-detail-panel"),
      detailsTitle:       document.getElementById("details-title"),
      detailsContent:     document.getElementById("details-content"),
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

      viewAsField:          document.querySelector(".top-bar-viewas"),
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
      pathStartUseMine:     document.getElementById("path-start-use-mine"),
      pathTargetPlayerFields: document.getElementById("path-target-player-fields"),
      pathTargetCoordsFields: document.getElementById("path-target-coords-fields"),
      pathTargetX:          document.getElementById("path-target-x"),
      pathTargetY:          document.getElementById("path-target-y"),
      pathTargetInput:      document.getElementById("path-target-input"),
      pathTargetResults:    document.getElementById("path-target-results"),
      pathDistanceReadout:  document.getElementById("path-distance-readout"),
      pathAlwaysTier:          document.getElementById("path-always-tier"),
      pathSkipHardAbunakki:    document.getElementById("path-skip-hard-abunakki"),
      pathPlanButton:          document.getElementById("path-plan-button"),
      pathResults:       document.getElementById("path-results"),
      pathResultHops:    document.getElementById("path-result-hops"),
      pathResultCost:    document.getElementById("path-result-cost"),
      pathResultTakeover: document.getElementById("path-result-takeover"),
      pathResultTotal:    document.getElementById("path-result-total"),
      pathResultKits:    document.getElementById("path-result-kits"),
      pathProgressReadout: document.getElementById("path-progress-readout"),
      pathSaveButton:      document.getElementById("path-save-button"),
      pathStatus:          document.getElementById("path-status"),

      activityToggleButton: document.getElementById("activity-toggle-button"),
      activityModal:        document.getElementById("activity-modal"),
      activityCloseButton:  document.getElementById("activity-close-button"),
      activityTabEvents:           document.getElementById("activity-tab-events"),
      activityTabActivityLb:       document.getElementById("activity-tab-activity-leaderboard"),
      activityTabEmpireLb:         document.getElementById("activity-tab-empire-leaderboard"),
      activityTabInactive:         document.getElementById("activity-tab-inactive"),
      activityPanelEvents:         document.getElementById("activity-panel-events"),
      activityPanelActivityLb:     document.getElementById("activity-panel-activity-leaderboard"),
      activityPanelEmpireLb:       document.getElementById("activity-panel-empire-leaderboard"),
      activityPanelInactive:       document.getElementById("activity-panel-inactive"),
      activityEventsTypeOptions: document.getElementById("activity-events-type-options"),
      activityEventsPlayerInput: document.getElementById("activity-events-player-input"),
      activityEventsList:        document.getElementById("activity-events-list"),
      activityEventsMoreButton:  document.getElementById("activity-events-more-button"),
      activityEventsStatus:      document.getElementById("activity-events-status"),
      activityAlFilterInput: document.getElementById("activity-al-filter-input"),
      activityAlTable:       document.getElementById("activity-al-table"),
      activityAlTbody:       document.getElementById("activity-al-tbody"),
      activityAlMoreButton:  document.getElementById("activity-al-more-button"),
      activityAlStatus:      document.getElementById("activity-al-status"),
      activityElFilterInput: document.getElementById("activity-el-filter-input"),
      activityElTable:       document.getElementById("activity-el-table"),
      activityElTbody:       document.getElementById("activity-el-tbody"),
      activityElMoreButton:  document.getElementById("activity-el-more-button"),
      activityElStatus:      document.getElementById("activity-el-status"),
      activityInactiveDays:   document.getElementById("activity-inactive-days"),
      activityInactiveList:   document.getElementById("activity-inactive-list"),
      activityInactiveStatus: document.getElementById("activity-inactive-status"),

      locateToggleButton: document.getElementById("locate-toggle-button"),
      locatePopover:      document.getElementById("locate-popover"),
      locateInput:        document.getElementById("locate-input"),
      locateSearchButton: document.getElementById("locate-search-button"),
      locateResults:      document.getElementById("locate-results"),
      locateStatus:       document.getElementById("locate-status"),
    };
  }

  async start() {
    // Portal dropdowns to <body> — backdrop-filter on .map-tool-panel breaks position:fixed children.
    [
      this.elements.searchResults, this.elements.filterPlayerResults,
      this.elements.viewAsResults, this.elements.pathStartResults, this.elements.pathTargetResults,
    ].forEach(el => { if (el) document.body.appendChild(el); });

    this.config = setViewerConfig({ ...STABLE_VIEWER_CONFIG });
    this.api = new ApiClient(this.config);

    this._setupMapRenderer();
    this._setupEventListeners();
    this._setupWorldSelector();

    // Captured before _initPolledWorlds() writes its own fallback to this same key.
    this._hadStoredWorldSelection = !!localStorage.getItem(SELECTED_WORLD_STORAGE_KEY);

    await this._initPolledWorlds();

    // Try to restore session from localStorage
    const tokenKey = buildTokenStorageKey(this.config);
    const saved = localStorage.getItem(tokenKey);
    if (saved) {
      try {
        const session = JSON.parse(saved);
        await this._restoreSession(session.token);
      } catch {
        localStorage.removeItem(buildTokenStorageKey(this.config));
      }
    }
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
      this._enrichSelectedCell(cell);
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
      loginForm,
      logoutButton,
      findHomeButton,
      refreshButton,
      zoomInButton,
      zoomOutButton,
      searchToggleButton,
      searchInput,
    } = this.elements;

    loginForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this._handleLogin();
    });

    logoutButton?.addEventListener("click", () => this._handleLogout());

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
    this._setupSessionPopover();
    this._setupLegendPanel();
    this._setupViewAs();
    this._setupPathPanel();
    this._setupActivityModal();
    this._setupLocate();

    this.elements.detailsCloseButton?.addEventListener("click", () => this._deselectCell());

    // Keyboard shortcuts — ignored while typing (_isTypingInField()).
    document.addEventListener("keydown", (e) => {
      if (_isTypingInField()) return;
      if (e.key === "+" || e.key === "=") this.renderer?.zoomIn();
      if (e.key === "-") this.renderer?.zoomOut();
      if (e.key === "h" || e.key === "H") {
        const home = this.renderer?.findHomeCell();
        if (home) this._jumpTo(home.x, home.y);
      }
      if (e.key === "Escape") this._deselectCell();
    });
  }

  // ─── Session popover (top bar) ─────────────────────────────────────────────

  _setupSessionPopover() {
    const { sessionTriggerButton, sessionPopover } = this.elements;
    if (!sessionTriggerButton || !sessionPopover) return;

    sessionTriggerButton.addEventListener("click", () => this._toggleSessionPopover());

    document.addEventListener("click", (e) => {
      if (sessionPopover.hidden) return;
      if (sessionPopover.contains(e.target) || sessionTriggerButton.contains(e.target)) return;
      this._closeSessionPopover();
    }, true);
  }

  _toggleSessionPopover() {
    if (this.elements.sessionPopover?.hidden) this._openSessionPopover();
    else this._closeSessionPopover();
  }

  _openSessionPopover() {
    const { sessionPopover, sessionTriggerButton, emailInput } = this.elements;
    if (!sessionPopover) return;
    sessionPopover.hidden = false;
    sessionTriggerButton?.setAttribute("aria-expanded", "true");
    if (!this.session) emailInput?.focus();
  }

  _closeSessionPopover() {
    const { sessionPopover, sessionTriggerButton } = this.elements;
    if (!sessionPopover) return;
    sessionPopover.hidden = true;
    sessionTriggerButton?.setAttribute("aria-expanded", "false");
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

  _setupNameAutocomplete(input, resultsEl, onPick) {
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
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

  // Identity driving "mine"/find-home/route progress — real login wins when
  // it matches the viewed world, else View As. Never unlocks canEnrich.
  _effectiveIdentity() {
    if (this.canEnrich && this.session) return { uid: this.session.user.userid, name: this.session.user.username };
    if (this._viewAs) return this._viewAs;
    return null;
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
    this._updateEnrichAvailability(); // re-derives renderer.myUserId, find-home, and the route's progress markers
    this._updateViewAsUI();
  }

  _clearViewAs() {
    if (!this.selectedWorldId) return;
    this._viewAs = null;
    localStorage.removeItem(buildViewAsKey(this.selectedWorldId));
    if (this.elements.viewAsInput) this.elements.viewAsInput.value = "";
    this._updateEnrichAvailability();
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
    const { viewAsField, viewAsTriggerLabel, viewAsStatus, viewAsClearButton, viewAsInput } = this.elements;
    if (viewAsField) viewAsField.hidden = this.canEnrich; // redundant once real login covers this world
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

    this._setupNameAutocomplete(pathStartInput, pathStartResults, (entry) => {
      this._pathStartPick = this._findPlayerByName(entry.n);
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo();
      this._updatePathPlanAvailability();
    });

    this._setupNameAutocomplete(pathTargetInput, pathTargetResults, (entry) => {
      this._pathTargetPick = this._findPlayerByName(entry.n);
      this._updatePathDistanceReadout();
      this._updatePathStartLaunchInfo(); // start's auto-pick depends on target too
      this._updatePathPlanAvailability();
    });

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

  // Each side is independently "player" or "coordinates". Target resolves
  // first (closest outpost to start — see _pickPathCell()); start resolves
  // second via _pickBestLaunchCell() now that target is known.
  _resolvePathCells() {
    const startMode  = document.querySelector('input[name="path-start-mode"]:checked')?.value  || "player";
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";

    const startCoords  = startMode  === "coords" ? this._readPathCoords("start")  : null;
    const targetCoords = targetMode === "coords" ? this._readPathCoords("target") : null;

    const startRefForTarget = startMode === "coords" ? { home: startCoords, outposts: [] } : this._pathStartPick;
    const targetCell = targetMode === "coords"
      ? targetCoords
      : _pickPathCell(this._pathTargetPick, startRefForTarget);

    const startCell = startMode === "coords"
      ? startCoords
      : _pickBestLaunchCell(this._pathStartPick, targetCell);

    const startRange = startMode === "player" ? _flingerRangeOf(startCell) : 0;

    return { startCell, targetCell, startRange };
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
    const { startCell, targetCell } = this._resolvePathCells();
    const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";
    if (targetMode === "player" && this._pathTargetPick && !this._pathTargetPick.outposts.length) {
      el.textContent = `${escapeHtml(this._pathTargetPick.name)} has no outposts loaded — their home base can't be taken over, so there's no valid target here.`;
      el.hidden = false;
      return;
    }
    if (!startCell || !targetCell) { el.hidden = true; return; }
    const { distance } = wrappedHexDistance(startCell.x, startCell.y, targetCell.x, targetCell.y);
    el.textContent = `Straight-line distance: ${distance} hex${distance === 1 ? "" : "es"}`;
    el.hidden = false;
  }

  _updatePathStartLaunchInfo() {
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

  _updatePathPlanAvailability() {
    const btn = this.elements.pathPlanButton;
    if (!btn) return;
    const { startCell, targetCell } = this._resolvePathCells();
    btn.disabled = !(startCell && targetCell);
  }

  _planRoute() {
    if (!this.renderer) return;
    const { startCell, targetCell, startRange } = this._resolvePathCells();
    if (!startCell || !targetCell) {
      const targetMode = document.querySelector('input[name="path-target-mode"]:checked')?.value || "player";
      this._setPathStatus(
        targetMode === "player" && this._pathTargetPick && !this._pathTargetPick.outposts.length
          ? `${this._pathTargetPick.name} has no outposts loaded — their home base can't be taken over, so there's no valid target.`
          : "Pick both a start and a target first.",
      );
      return;
    }

    const jumpCap         = Number(document.querySelector('input[name="path-jumpcap"]:checked')?.value) || 4;
    const allowPlayers     = document.querySelector('input[name="path-mode"]:checked')?.value === "players";
    const skipHardAbunakki = !!this.elements.pathSkipHardAbunakki?.checked;
    const alwaysTier       = !!this.elements.pathAlwaysTier?.checked;

    this._setPathStatus("Planning…");

    const options = {
      jumpCap,
      allowPlayers,
      skipHardAbunakki,
      costMode: alwaysTier ? "hops" : "kitCost",
      forceTierRange: alwaysTier ? jumpCap : null,
      firstHopRange: startRange,
      homeCell: this._pathStartPick?.home ?? null,
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
      pathResults, pathResultHops, pathResultCost, pathResultTakeover, pathResultTotal,
      pathResultKits, pathProgressReadout,
    } = this.elements;
    if (!pathResults) return;

    const r = this.currentRoute;
    if (!r) { pathResults.hidden = true; return; }
    pathResults.hidden = false;

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

  // ─── Activity modal (events / activity leaderboard / empire leaderboard / inactive) ──

  _setupActivityModal() {
    const {
      activityToggleButton, activityModal, activityCloseButton,
      activityTabEvents, activityTabActivityLb, activityTabEmpireLb, activityTabInactive,
      activityEventsTypeOptions, activityEventsPlayerInput, activityEventsMoreButton, activityEventsList,
      activityAlFilterInput, activityAlTable, activityAlMoreButton,
      activityElFilterInput, activityElTable, activityElMoreButton,
      activityInactiveDays,
    } = this.elements;
    if (!activityToggleButton || !activityModal) return;

    activityToggleButton.addEventListener("click", () => this._openActivityModal());
    activityCloseButton?.addEventListener("click", () => this._closeActivityModal());

    activityModal.addEventListener("click", (e) => {
      if (e.target === activityModal) this._closeActivityModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !activityModal.hidden) this._closeActivityModal();
    });

    activityTabEvents?.addEventListener("click", () => this._switchActivityTab("events"));
    activityTabActivityLb?.addEventListener("click", () => this._switchActivityTab("activity-leaderboard"));
    activityTabEmpireLb?.addEventListener("click", () => this._switchActivityTab("empire-leaderboard"));
    activityTabInactive?.addEventListener("click", () => this._switchActivityTab("inactive"));

    activityEventsTypeOptions?.addEventListener("change", () => this._loadEvents({ reset: true }));

    // Debounced — avoid firing a request per keystroke while typing a name.
    let playerFilterTimer = null;
    activityEventsPlayerInput?.addEventListener("input", () => {
      clearTimeout(playerFilterTimer);
      playerFilterTimer = setTimeout(() => this._loadEvents({ reset: true }), 300);
    });

    activityEventsMoreButton?.addEventListener("click", () => this._loadEvents({ reset: false }));

    activityEventsList?.addEventListener("click", (e) => {
      const row = e.target.closest("[data-jump-x]");
      if (row) this._jumpToCell(Number(row.dataset.jumpX), Number(row.dataset.jumpY));
    });

    activityAlFilterInput?.addEventListener("input", () => this._renderActivityLeaderboard({ resetShown: true }));
    activityAlTable?.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) this._sortLeaderboard("activity", th.dataset.sort);
    });
    activityAlMoreButton?.addEventListener("click", () => {
      this._activityLbShown += 50;
      this._renderActivityLeaderboard();
    });

    activityElFilterInput?.addEventListener("input", () => this._renderEmpireLeaderboard({ resetShown: true }));
    activityElTable?.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) this._sortLeaderboard("empire", th.dataset.sort);
    });
    activityElMoreButton?.addEventListener("click", () => {
      this._empireLbShown += 50;
      this._renderEmpireLeaderboard();
    });

    activityInactiveDays?.addEventListener("change", () => this._loadInactivePlayers());
  }

  _openActivityModal() {
    if (!this.elements.activityModal) return;
    this.elements.activityModal.hidden = false;
    this._switchActivityTab(this._activityTab, { forceReload: true });
  }

  _closeActivityModal() {
    if (this.elements.activityModal) this.elements.activityModal.hidden = true;
  }

  _switchActivityTab(tab, { forceReload = false } = {}) {
    const changed = tab !== this._activityTab;
    this._activityTab = tab;

    const tabs = {
      events:              [this.elements.activityTabEvents,     this.elements.activityPanelEvents],
      "activity-leaderboard": [this.elements.activityTabActivityLb, this.elements.activityPanelActivityLb],
      "empire-leaderboard":   [this.elements.activityTabEmpireLb,   this.elements.activityPanelEmpireLb],
      inactive:            [this.elements.activityTabInactive,   this.elements.activityPanelInactive],
    };
    for (const [key, [tabBtn, panel]] of Object.entries(tabs)) {
      const active = key === tab;
      tabBtn?.setAttribute("aria-selected", String(active));
      if (panel) panel.hidden = !active;
    }

    if (!changed && !forceReload) return;
    if (tab === "events") this._loadEvents({ reset: true });
    else if (tab === "activity-leaderboard") this._loadActivityLeaderboard();
    else if (tab === "empire-leaderboard") this._loadEmpireLeaderboard();
    else if (tab === "inactive") this._loadInactivePlayers();
  }

  _setActivityStatus(elementKey, msg) {
    if (this.elements[elementKey]) this.elements[elementKey].textContent = msg;
  }

  async _loadEvents({ reset = true } = {}) {
    if (!this.selectedWorldId) return;
    const { activityEventsList, activityEventsMoreButton } = this.elements;
    if (!activityEventsList) return;

    if (reset) {
      this._eventsCursor = null;
      this._eventsExhausted = false;
    }

    const checkedTypes = [...document.querySelectorAll('#activity-events-type-options input[type=checkbox]:checked')]
      .map((cb) => cb.value);
    // 2 checked types fetches unfiltered and narrows client-side.
    const singleType = checkedTypes.length === 1 ? checkedTypes[0] : null;
    const clientFilterTypes = checkedTypes.length === 2 ? new Set(checkedTypes) : null;
    const player = this.elements.activityEventsPlayerInput?.value?.trim() || "";

    this._setActivityStatus("activityEventsStatus", "Loading…");

    try {
      const { groups, nextBeforeId } = await this.api.getEvents(this.selectedWorldId, {
        type: singleType, player, beforeId: this._eventsCursor, limit: 20,
      });
      const shown = clientFilterTypes ? groups.filter((g) => clientFilterTypes.has(g.event_type)) : groups;

      this._eventsExhausted = nextBeforeId == null;
      this._eventsCursor = nextBeforeId;

      this._renderEventGroups(shown, { append: !reset });
      if (activityEventsMoreButton) activityEventsMoreButton.hidden = this._eventsExhausted;
      this._setActivityStatus("activityEventsStatus", "");
    } catch (err) {
      this._setActivityStatus("activityEventsStatus", err?.message || "Failed to load events.");
    }
  }

  _renderEventGroups(groups, { append = false } = {}) {
    const list = this.elements.activityEventsList;
    if (!list) return;
    if (!append) list.innerHTML = "";

    if (!groups.length) {
      if (!append && !list.children.length) list.innerHTML = `<div class="activity-list-empty">No events match these filters.</div>`;
      return;
    }

    for (const g of groups) {
      // Single-event groups jump straight to their cell; multi-event groups are
      // a summary row ("Player A took 5 outposts from Player B") plus an always-
      // visible list of the individual cells, each clickable on its own — except
      // RECYCLED, which skips the cell list: a mass-recycle can be thousands of
      // outposts in one group, which would otherwise flood the screen with pills.
      const clickable = g.count === 1;
      const showCellList = !clickable && g.event_type !== "RECYCLED";
      const row = document.createElement(clickable ? "button" : "div");
      if (clickable) row.type = "button";
      row.className = "activity-list-item" + (clickable ? " activity-list-item--clickable" : "");
      const coordsMeta = clickable
        ? `<div class="activity-list-item-meta">(${g.cells[0].x}, ${g.cells[0].y})</div>`
        : "";
      row.innerHTML = `
        <div class="activity-list-item-main">
          <div class="activity-list-item-desc">${_describeEventGroup(g)}</div>
          ${coordsMeta}
        </div>
        <div class="activity-list-item-time">${_fmtRelTime(g.detected_at)}</div>
      `;
      if (clickable) {
        row.dataset.jumpX = g.cells[0].x;
        row.dataset.jumpY = g.cells[0].y;
      }
      list.appendChild(row);

      if (showCellList) {
        const cellsEl = document.createElement("div");
        cellsEl.className = "activity-event-cells";
        cellsEl.innerHTML = g.cells
          .map((c) => `<button type="button" data-jump-x="${c.x}" data-jump-y="${c.y}">(${c.x}, ${c.y})</button>`)
          .join("");
        list.appendChild(cellsEl);
      }
    }
  }

  /** Closes the modal, centers on (x, y), and selects the cell if loaded. */
  _jumpToCell(x, y) {
    this._closeActivityModal();
    if (!this.renderer) return;
    this._jumpTo(x, y);
    const cell = this.renderer.getCellAt(x, y);
    if (cell) {
      this.selectedCell = cell;
      this.renderer.selectedCell = cell;
      this.renderer.markDirty();
      this._renderDetails(cell);
    }
  }

  // ─── Locate — find which world a player is currently on (searches every polled world) ──

  _setupLocate() {
    const { locateToggleButton, locatePopover, locateInput, locateSearchButton, locateResults } = this.elements;
    if (!locateToggleButton || !locatePopover) return;

    locateToggleButton.addEventListener("click", () => this._toggleLocatePopover());

    document.addEventListener("click", (e) => {
      if (locatePopover.hidden) return;
      if (locatePopover.contains(e.target) || locateToggleButton.contains(e.target)) return;
      this._closeLocatePopover();
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !locatePopover.hidden) this._closeLocatePopover();
    });

    // Debounced live suggestions (min 2 chars); Find/Enter search immediately, no debounce.
    let suggestTimer = null;
    locateInput?.addEventListener("input", () => {
      clearTimeout(suggestTimer);
      const term = locateInput.value.trim();
      if (term.length < 2) {
        this._setLocateStatus(term.length === 0 ? "" : "Keep typing — at least 2 characters.");
        this._renderLocateResults([]);
        return;
      }
      suggestTimer = setTimeout(() => this._searchLocate(term), 250);
    });

    const searchNow = () => {
      clearTimeout(suggestTimer);
      const term = locateInput?.value?.trim();
      if (term) this._searchLocate(term);
    };
    locateSearchButton?.addEventListener("click", searchNow);
    locateInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") searchNow(); });

    locateResults?.addEventListener("click", (e) => {
      const btn = e.target.closest(".locate-result");
      if (!btn) return;
      const match = this._locateMatches?.[Number(btn.dataset.index)];
      if (match) this._jumpToLocateResult(match);
    });
  }

  _toggleLocatePopover() {
    if (this.elements.locatePopover?.hidden) this._openLocatePopover();
    else this._closeLocatePopover();
  }

  _openLocatePopover() {
    const { locatePopover, locateToggleButton, locateInput } = this.elements;
    if (!locatePopover) return;
    locatePopover.hidden = false;
    locateToggleButton?.setAttribute("aria-expanded", "true");
    locateInput?.focus();
  }

  _closeLocatePopover() {
    const { locatePopover, locateToggleButton } = this.elements;
    if (!locatePopover) return;
    locatePopover.hidden = true;
    locateToggleButton?.setAttribute("aria-expanded", "false");
  }

  _setLocateStatus(msg) {
    if (this.elements.locateStatus) this.elements.locateStatus.textContent = msg;
  }

  /** Substring, case-insensitive name search across every world — see db.search_players(). */
  async _searchLocate(term) {
    const { locateStatus } = this.elements;
    this._setLocateStatus("Searching…");

    try {
      const matches = await this.api.suggestPlayers(term, { limit: 8 });
      this._locateMatches = matches;
      if (!matches.length) {
        this._setLocateStatus(`No one matching "${term}" on any polled world — either the name's wrong, or they've never had a home base on one.`);
        this._renderLocateResults([]);
        return;
      }
      this._setLocateStatus("");
      this._renderLocateResults(matches);
    } catch (err) {
      this._locateMatches = [];
      this._renderLocateResults([]);
      this._setLocateStatus(err?.message || "Search failed.");
    }
  }

  _renderLocateResults(matches) {
    const list = this.elements.locateResults;
    if (!list) return;
    list.innerHTML = matches.map((m, i) => `
      <button type="button" class="locate-result" data-index="${i}">
        <span class="locate-result-name">${escapeHtml(m.name || "Unknown")}</span>
        <span class="locate-result-world">${escapeHtml(m.world_name || m.world_uuid)}</span>
        <span class="locate-result-coords">(${m.x}, ${m.y}) — ${_fmtNum(m.empirevalue)} empire value</span>
      </button>
    `).join("");
  }

  async _jumpToLocateResult(match) {
    this._closeLocatePopover();
    await this._selectWorld(match.world_uuid);
    this._jumpToCell(match.x, match.y);
  }

  // ─── Activity Leaderboard — outpost gains/losses, all players ──────────────
  // Fetched once, unpaginated; sort/filter/"View more" re-render from the cached array.

  async _loadActivityLeaderboard() {
    if (!this.selectedWorldId) return;
    this._setActivityStatus("activityAlStatus", "Loading…");
    try {
      this._activityLbRows = await this.api.getActivityLeaderboard(this.selectedWorldId);
      this._activityLbShown = 50;
      this._renderActivityLeaderboard();
      this._setActivityStatus("activityAlStatus", "");
    } catch (err) {
      this._activityLbRows = [];
      this._setActivityStatus("activityAlStatus", err?.message || "Failed to load the activity leaderboard.");
    }
  }

  _renderActivityLeaderboard({ resetShown = false } = {}) {
    const tbody = this.elements.activityAlTbody;
    if (!tbody) return;
    if (resetShown) this._activityLbShown = 50;

    const filter = this.elements.activityAlFilterInput?.value?.trim().toLowerCase() || "";
    const filtered = filter
      ? this._activityLbRows.filter((r) => (r.name || "").toLowerCase().includes(filter))
      : this._activityLbRows;

    const withNet = filtered.map((r) => ({
      ...r,
      net_day: r.gain_day - r.loss_day, net_week: r.gain_week - r.loss_week, net_month: r.gain_month - r.loss_month,
    }));
    const sorted = _sortRows(withNet, this._activityLbSort);
    const shown = sorted.slice(0, this._activityLbShown);

    if (!shown.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="activity-list-empty">${filter ? "No players match that filter." : "No outpost activity recorded yet."}</td></tr>`;
    } else {
      tbody.innerHTML = shown.map((r) => `
        <tr>
          <td>${escapeHtml(r.name || "Unknown")}</td>
          <td>${_fmtNum(r.outpost_count)}</td>
          <td>${_fmtGainLoss(r.gain_day, r.loss_day)}</td>
          <td>${_fmtGainLoss(r.gain_week, r.loss_week)}</td>
          <td>${_fmtGainLoss(r.gain_month, r.loss_month)}</td>
        </tr>
      `).join("");
    }

    this.elements.activityAlMoreButton.hidden = sorted.length <= this._activityLbShown;
    _updateSortHeaders(this.elements.activityAlTable, this._activityLbSort);
  }

  // ─── Empire Points Leaderboard — current total value, all players ──────────

  async _loadEmpireLeaderboard() {
    if (!this.selectedWorldId) return;
    this._setActivityStatus("activityElStatus", "Loading…");
    try {
      this._empireLbRows = await this.api.getEmpireLeaderboard(this.selectedWorldId);
      this._empireLbShown = 50;
      this._renderEmpireLeaderboard();
      this._setActivityStatus("activityElStatus", "");
    } catch (err) {
      this._empireLbRows = [];
      this._setActivityStatus("activityElStatus", err?.message || "Failed to load the empire points leaderboard.");
    }
  }

  _renderEmpireLeaderboard({ resetShown = false } = {}) {
    const tbody = this.elements.activityElTbody;
    if (!tbody) return;
    if (resetShown) this._empireLbShown = 50;

    const filter = this.elements.activityElFilterInput?.value?.trim().toLowerCase() || "";
    const filtered = filter
      ? this._empireLbRows.filter((r) => (r.name || "").toLowerCase().includes(filter))
      : this._empireLbRows;

    const sorted = _sortRows(filtered, this._empireLbSort);
    const shown = sorted.slice(0, this._empireLbShown);

    if (!shown.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="activity-list-empty">${filter ? "No players match that filter." : "No players found on this world."}</td></tr>`;
    } else {
      tbody.innerHTML = shown.map((r) => `
        <tr>
          <td>${escapeHtml(r.name || "Unknown")}</td>
          <td>${_fmtNum(r.total_empirevalue)}</td>
          <td>${_fmtNum(r.total_cells)}</td>
          <td>${_fmtSignedCls(r.delta_day)}</td>
          <td>${_fmtSignedCls(r.delta_week)}</td>
          <td>${_fmtSignedCls(r.delta_month)}</td>
        </tr>
      `).join("");
    }

    this.elements.activityElMoreButton.hidden = sorted.length <= this._empireLbShown;
    _updateSortHeaders(this.elements.activityElTable, this._empireLbSort);
  }

  _sortLeaderboard(which, field) {
    const state = which === "activity" ? this._activityLbSort : this._empireLbSort;
    if (state.field === field) state.dir = state.dir === "desc" ? "asc" : "desc";
    else { state.field = field; state.dir = "desc"; }
    if (which === "activity") this._renderActivityLeaderboard();
    else this._renderEmpireLeaderboard();
  }

  async _loadInactivePlayers() {
    if (!this.selectedWorldId) return;
    const list = this.elements.activityInactiveList;
    if (!list) return;

    const days = Math.max(1, Number(this.elements.activityInactiveDays?.value) || 7);
    this._setActivityStatus("activityInactiveStatus", "Loading…");

    try {
      const rows = await this.api.getInactivePlayers(this.selectedWorldId, { days });
      list.innerHTML = "";
      if (!rows.length) {
        list.innerHTML = `<div class="activity-list-empty">No one's gone that long without a gain — or not enough polling history yet to tell.</div>`;
      } else {
        for (const r of rows) {
          const row = document.createElement("div");
          row.className = "activity-list-item";
          row.innerHTML = `
            <div class="activity-list-item-main">
              <div class="activity-list-item-desc">${escapeHtml(r.name || "Unknown")}</div>
            </div>
            <div class="activity-list-item-time">last gain ${_fmtRelTime(r.last_gained_at)}</div>
          `;
          list.appendChild(row);
        }
      }
      this._setActivityStatus("activityInactiveStatus", "");
    } catch (err) {
      this._setActivityStatus("activityInactiveStatus", err?.message || "Failed to load inactive players.");
    }
  }

  // ─── Session management ──────────────────────────────────────────────────────

  async _handleLogin() {
    const email    = this.elements.emailInput?.value?.trim();
    const password = this.elements.passwordInput?.value;
    if (!email || !password) return;

    this._setLoginBusy(true);
    this._showStatus("Signing in...");

    try {
      const apiVersion = await this.api.resolveApiVersion();
      this.config = setViewerConfig({ ...this.config, apiVersion });
      this.api = new ApiClient(this.config);

      const session = await this.api.login(email, password);
      await this._applySession(session);
      this._closeSessionPopover(); // the login form did its job — get out of the way
    } catch (err) {
      this._setLoginBusy(false);
      this._showStatus(err.message || "Login failed.");
    }
  }

  async _restoreSession(token) {
    try {
      const apiVersion = await this.api.resolveApiVersion();
      this.config = setViewerConfig({ ...this.config, apiVersion });
      this.api = new ApiClient(this.config);

      const session = await this.api.refresh(token);
      await this._applySession(session);
    } catch {
      // not logged in, or the saved session expired — map still loads fine
    }
  }

  async _applySession(session) {
    this.session = session;
    const tokenKey = buildTokenStorageKey(this.config);
    localStorage.setItem(tokenKey, JSON.stringify({ token: session.token }));

    this._setLoginBusy(false);
    this._showStatus("");

    if (!this.session.map?.worldid) await this._resolveWorldId();

    this._updateSessionUI();
    this._updateEnrichAvailability();

    const myWorldId = this.session.map?.worldid;
    if (!this._hadStoredWorldSelection && myWorldId && this.polledWorlds.some((w) => w.uuid === myWorldId)) {
      await this._selectWorld(myWorldId);
    }
  }

  _handleLogout() {
    const tokenKey = buildTokenStorageKey(this.config);
    localStorage.removeItem(tokenKey);

    this.session = null;
    this._updateEnrichAvailability();
    this._updateSessionUI();

    this.elements.logoutButton.hidden = true;
    this.elements.loginForm.hidden = false;
  }

  _updateSessionUI() {
    const { session } = this;

    if (session) {
      this.elements.sessionName.textContent = session.user.username || "Signed in";
      this.elements.loginForm.hidden = true;
      this.elements.logoutButton.hidden = false;
      if (this.elements.sessionTriggerLabel) this.elements.sessionTriggerLabel.textContent = session.user.username || "Signed in";
    } else {
      this.elements.sessionName.textContent = "";
      this.elements.loginForm.hidden = false;
      this.elements.logoutButton.hidden = true;
      if (this.elements.sessionTriggerLabel) this.elements.sessionTriggerLabel.textContent = "Sign in";
    }

    const worldEl = this.elements.sessionWorld;
    if (worldEl) {
      const myWorldId = session?.map?.worldid;
      const myWorld = myWorldId ? this.polledWorlds.find((w) => w.uuid === myWorldId) : null;

      if (!session || !myWorldId) {
        worldEl.hidden = true;
      } else if (myWorld) {
        const onScreen = myWorldId === this.selectedWorldId;
        worldEl.textContent = onScreen
          ? `World: ${myWorld.name} (resources available)`
          : `World: ${myWorld.name} (switch to it above to see resources)`;
        worldEl.hidden = false;
      } else {
        worldEl.innerHTML = NOT_ON_MR2_MESSAGE;
        worldEl.hidden = false;
      }
    }
  }

  _setLoginBusy(busy) {
    if (this.elements.loginButton) this.elements.loginButton.disabled = busy;
    if (this.elements.emailInput) this.elements.emailInput.disabled = busy;
    if (this.elements.passwordInput) this.elements.passwordInput.disabled = busy;
  }

  _showStatus(msg) {
    if (this.elements.sessionStatus) this.elements.sessionStatus.textContent = msg;
  }

  // Gates the map toolbar on world data being loaded, not login. find-home
  // has its own narrower gate — see _updateFindHomeAvailability().
  _setMapControlsEnabled(enabled) {
    this.elements.refreshButton.disabled = !enabled;
    this.elements.searchToggleButton.disabled = !enabled;
    this.elements.searchInput.disabled = !enabled;
    if (this.elements.pathToggleButton) this.elements.pathToggleButton.disabled = !enabled;
    if (this.elements.activityToggleButton) this.elements.activityToggleButton.disabled = !enabled;
    if (this.elements.locateToggleButton) this.elements.locateToggleButton.disabled = !enabled;
    this._enableFilterControls(enabled);
  }

  // Only enabled when an identity (login or View As) is known — otherwise there's no "mine" cell to find.
  _updateFindHomeAvailability() {
    const btn = this.elements.findHomeButton;
    if (!btn) return;
    const available = this._effectiveMyUid() != null;
    btn.disabled = !available;
    btn.title = available ? "Jump to home base (H)" : "Log in, or set “View as”, to find your home base";
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
    this._closeActivityModal();

    this._updateEnrichAvailability();
    this._updateSessionUI();
    this._centerOnStoredHome();

    try {
      await this._loadWorld({ useCache: true });
    } catch { /* _doLoadWorld already surfaced a status message */ }

    this._restoreRouteForWorld();
  }

  // Gates click-to-enrich; also keeps renderer.myUserId, find-home, View As
  // visibility, and the on-screen route's progress markers in sync.
  _updateEnrichAvailability() {
    this.canEnrich = !!(this.session?.map?.worldid && this.session.map.worldid === this.selectedWorldId);
    const myUid = this._effectiveMyUid();
    if (this.renderer) {
      this.renderer.myUserId = myUid;
      this.renderer.markDirty();
    }
    this._updateFindHomeAvailability();
    this._updateViewAsUI();
    if (this.currentRoute) this.renderer?.setRoute(this.currentRoute.route, myUid, this.currentRoute.originalOwners);
  }

  // ─── Map loading ────────────────────────────────────────────────────────────
  // Loads in two requests — /worldmapv2/terrain (byte-per-cell height map) and
  // /worldmapv2/snapshot (occupied cells) — no chunk-crawling. Unattacked wild
  // camps are reconstructed client-side from pure functions of (x, y, worldid).

  _bumpWorldLoadGeneration() {
    this._worldLoadGeneration++;
    this._worldLoadPromise = null;
  }

  // /base/load is the only endpoint that returns worldid. Not cached across
  // logins — a player can relocate, so this always resolves fresh.
  async _resolveWorldId() {
    const userid = this.session.user.userid;
    try {
      const save = await this.api.getOwnSave(this.session.token, userid);
      const worldid = save?.worldid || "";
      if (worldid) this.session.map = { ...this.session.map, worldid };
    } catch (err) {
      this._showStatus(err?.message || "Failed to resolve your world.");
    }
  }

  // Shared by _selectWorld, refresh, and export.js — concurrent callers coalesce onto one fetch.
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
        const [cachedTerrain, cachedSnapshot] = await Promise.all([
          sessionCacheGet(buildTerrainCacheKey(worldid)),
          sessionCacheGet(buildSnapshotCacheKey(worldid)),
        ]);
        if (myGeneration !== this._worldLoadGeneration) return; // superseded mid-fetch
        if (cachedTerrain?.bytes) terrainBytes = cachedTerrain.bytes;
        if (cachedSnapshot?.snapshot) snapshot = cachedSnapshot.snapshot;

        if (terrainBytes && snapshot) {
          this.renderer.loadWorld(terrainBytes, snapshot);
          this._terrainBytes = terrainBytes;
          this._worldLoaded  = true;
          this._hideOverlay();
          this._setMapControlsEnabled(true);
          this._updateSearchEntries();
          this._updateFilterCount();
          this._autoFindHome();
        }
      } catch { /* no cache, or a read failed — fall through to a normal fetch */ }
    }

    if (!terrainBytes) this._showOverlay("Loading world map...");

    let stepsDone = 0;
    const bump = () => { stepsDone++; this._showProgress("Loading world", stepsDone, 2); };
    this._showProgress("Loading world", 0, 2);

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

  // getarea backfill for a clicked cell's live fields (resources/monsters/truce/lock).
  async _enrichSelectedCell(cell) {
    if (!cell || !this.canEnrich || cell.uid === undefined) return; // no login for this world, or a water cell

    const token   = this.session.token;
    const request = ++this._enrichToken;

    try {
      const result = await this.api.getMapArea(token, cell.x, cell.y);
      if (request !== this._enrichToken) return; // a later click superseded this one

      const fresh = result?.data?.[cell.x]?.[cell.y];
      if (!fresh) return;

      const merged = this.renderer.normalizeCellLevel({ ...cell, ...fresh, x: cell.x, y: cell.y });
      this.renderer.cells.set(cellKey(cell.x, cell.y), merged);

      if (this.selectedCell?.x === cell.x && this.selectedCell?.y === cell.y) {
        this.selectedCell = merged;
        this.renderer.selectedCell = merged;
        this._renderDetails(merged);
      }
    } catch { /* keep showing the bulk-derived data on failure */ }
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
    if (!this.session || !this.selectedWorldId) return;
    const key = buildHomePosKey(this.session.user.userid, this.selectedWorldId);
    localStorage.setItem(key, JSON.stringify({ x, y }));
  }

  _centerOnStoredHome() {
    if (!this.renderer) return;
    if (this.session && this.selectedWorldId) {
      const key = buildHomePosKey(this.session.user.userid, this.selectedWorldId);
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
    const content  = this.elements.detailsContent;
    const closeBtn = this.elements.detailsCloseButton;
    if (!title || !content) return;

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

    title.textContent = `${owner} ${baseType}: ${escapeHtml(n || "?")} (${x}, ${y})`;
    content.innerHTML = `
      <div class="detail-row"><span>Coords</span><span>${x}, ${y}</span></div>
      <div class="detail-row"><span>Player</span><span>${escapeHtml(n || "Unknown")}</span></div>
      <div class="detail-row"><span>Type</span><span>${escapeHtml(baseType)}</span></div>
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
      ${!hasRes && !this.canEnrich ? LOGIN_PROMPT_HTML : ""}
    `;

    content.querySelector(".detail-login-button")?.addEventListener("click", () => this._openSessionPopover());
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

  _renderFilterPlayerChips() {
    const area = document.getElementById("filter-player-tags-area");
    const input = this.elements.filterPlayerInput;
    if (!area || !input) return;

    // Remove existing chips, leave the input intact
    area.querySelectorAll(".filter-player-chip").forEach((el) => el.remove());

    for (const [uid, name] of this._filterPlayers) {
      const chip = document.createElement("span");
      chip.className = "filter-player-chip";
      chip.innerHTML =
        `<span class="filter-player-chip-name">${escapeHtml(name)}</span>` +
        `<button class="filter-player-chip-remove" type="button" aria-label="Remove ${escapeHtml(name)}" data-uid="${uid}">×</button>`;
      area.insertBefore(chip, input);

      chip.querySelector("button").addEventListener("click", () => {
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
        const uid  = Number(btn.dataset.uid) || null;
        const name = btn.dataset.name;
        if (uid) this._filterPlayers.set(uid, name);
        this._renderFilterPlayerChips();
        filterPlayerInput.value = "";
        filterPlayerResults.hidden = true;
        this._applyFilter();
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
    this.renderer?.setFilter(hasAny ? { playerName, filterPlayerUids, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange, flingerLevels } : null);

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
