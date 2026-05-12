import { ApiClient } from "./api-client.js";
import { MapRenderer } from "./map-renderer.js";
import {
  MR2,
  STABLE_VIEWER_CONFIG,
  SERVER_SELECTION_STORAGE_KEY,
  SEARCH_RESULT_LIMIT,
  buildTokenStorageKey,
  buildFullMapCacheKey,
  escapeHtml,
  generateChunkCoords,
  getLocalViewerConfig,
  getTerrainLabel,
  isWater,
  sessionCacheDelete,
  sessionCacheGet,
  sessionCacheSet,
  setViewerConfig,
} from "./shared.js";

const SIGNED_OUT_OVERLAY_MESSAGE = "Please log in.";

// Compact number formatter: 1234567 → "1.2M", 5000 → "5K", 400 → "400"
// Negative values are clamped to 0 — they appear in the game DB as delta artefacts.
function _fmtNum(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

// ─── Simple concurrency semaphore ─────────────────────────────────────────────

class Semaphore {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    if (this.queue.length) this.queue.shift()();
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
    this.serverSelection = null;
    this.filterOpen = false;

    // Map load state
    this._loadAbortController = null;
    this._loadTotal = 0;
    this._loadDone = 0;
    this._loadInProgress = false;

    this.elements = {
      appRoot:            document.getElementById("app"),
      serverSelect:       document.getElementById("server-select"),
      serverCustomFields: document.getElementById("server-custom-fields"),
      serverHostInput:    document.getElementById("server-host-input"),
      serverPortInput:    document.getElementById("server-port-input"),
      emailInput:         document.getElementById("email-input"),
      passwordInput:      document.getElementById("password-input"),
      loginForm:          document.getElementById("login-form"),
      loginButton:        document.getElementById("login-button"),
      logoutButton:       document.getElementById("logout-button"),
      sessionName:        document.getElementById("session-name"),
      sessionStatus:      document.getElementById("session-status"),
      sessionWorld:       document.getElementById("session-world"),
      detailsTitle:       document.getElementById("details-title"),
      detailsContent:     document.getElementById("details-content"),
      mapCanvas:          document.getElementById("map-canvas"),
      mapCoordinates:     document.getElementById("map-coordinates"),
      mapOverlay:         document.getElementById("map-overlay"),
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
      sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
      filterToggleButton:   document.getElementById("filter-toggle-button"),
      filterPanel:          document.getElementById("filter-panel"),
      filterPlayerInput:    document.getElementById("filter-player-input"),
      filterPlayerResults:  document.getElementById("filter-player-results"),
      filterClearButton:    document.getElementById("filter-clear-button"),
      filterMatchCount:     document.getElementById("filter-match-count"),
    };
  }

  async start() {
    this._setupServerSelector();
    this._initConfig();
    this.api = new ApiClient(this.config);

    this._setupMapRenderer();
    this._setupEventListeners();

    // Try to restore session from localStorage
    const tokenKey = buildTokenStorageKey(this.config);
    const saved = localStorage.getItem(tokenKey);
    if (saved) {
      try {
        const session = JSON.parse(saved);
        await this._restoreSession(session.token);
        return;
      } catch {
        localStorage.removeItem(buildTokenStorageKey(this.config));
      }
    }

    this._showOverlay(SIGNED_OUT_OVERLAY_MESSAGE);
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────

  _initConfig() {
    const saved = localStorage.getItem(SERVER_SELECTION_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this.serverSelection = parsed.selection;
        const sel = this.elements.serverSelect;
        if (sel) {
          const option = sel.querySelector(`option[value="${this.serverSelection}"]`);
          if (option) sel.value = this.serverSelection;
        }
        if (this.serverSelection === "custom") {
          this._applyCustomServerConfig(parsed.host, parsed.port);
        } else if (this.serverSelection === "stable") {
          this.config = { ...STABLE_VIEWER_CONFIG };
        } else {
          this.config = getLocalViewerConfig();
        }
      } catch {
        this.config = getLocalViewerConfig();
      }
    } else {
      // Default to stable server when no selection is saved
      this.config = { ...STABLE_VIEWER_CONFIG };
      this.serverSelection = "stable";
      if (this.elements.serverSelect) this.elements.serverSelect.value = "stable";
    }

    this.config = setViewerConfig(this.config);
  }

  _setupServerSelector() {
    const { serverSelect, serverCustomFields, serverHostInput, serverPortInput } = this.elements;
    if (!serverSelect) return;

    serverSelect.addEventListener("change", () => {
      const val = serverSelect.value;
      serverCustomFields.hidden = val !== "custom";
      this._onServerSelectionChange(val);
    });

    [serverHostInput, serverPortInput].forEach((input) => {
      if (input) {
        input.addEventListener("change", () => {
          this._onServerSelectionChange("custom");
        });
      }
    });
  }

  _onServerSelectionChange(selection) {
    this.serverSelection = selection;

    if (selection === "stable") {
      this.config = setViewerConfig({ ...STABLE_VIEWER_CONFIG });
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection }));
    } else if (selection === "custom") {
      const host = this.elements.serverHostInput?.value?.trim() || "127.0.0.1";
      const port = this.elements.serverPortInput?.value || "3001";
      this._applyCustomServerConfig(host, port);
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection, host, port }));
    } else {
      this.config = setViewerConfig(getLocalViewerConfig());
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection }));
    }

    this.api = new ApiClient(this.config);
  }

  _applyCustomServerConfig(host, port) {
    const base = `http://${host}:${port}`;
    this.config = setViewerConfig({ bymBaseUrl: base, cdnBaseUrl: base });
    if (this.elements.serverHostInput) this.elements.serverHostInput.value = host;
    if (this.elements.serverPortInput) this.elements.serverPortInput.value = port;
    if (this.elements.serverCustomFields) this.elements.serverCustomFields.hidden = false;
    if (this.elements.serverSelect) this.elements.serverSelect.value = "custom";
  }

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
      loginForm,
      logoutButton,
      findHomeButton,
      refreshButton,
      zoomInButton,
      zoomOutButton,
      searchToggleButton,
      searchInput,
      sidebarToggleButton,
    } = this.elements;

    loginForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this._handleLogin();
    });

    logoutButton?.addEventListener("click", () => this._handleLogout());

    findHomeButton?.addEventListener("click", () => {
      if (!this.renderer) return;
      const home = this.renderer.findHomeCell();
      if (home) {
        this.renderer.centerOn(home.x, home.y);
      }
    });

    refreshButton?.addEventListener("click", () => {
      if (this.session) this._startFullMapLoad(true);
    });

    zoomInButton?.addEventListener("click", () => this.renderer?.zoomIn());
    zoomOutButton?.addEventListener("click", () => this.renderer?.zoomOut());

    searchToggleButton?.addEventListener("click", () => {
      const expanded = searchToggleButton.getAttribute("aria-expanded") === "true";
      const panel = document.getElementById("search-panel");
      searchToggleButton.setAttribute("aria-expanded", String(!expanded));
      if (panel) panel.hidden = expanded;
      if (!expanded) searchInput?.focus();
    });

    searchInput?.addEventListener("input", () => this._onSearchInput());

    this._setupFilterPanel();

    sidebarToggleButton?.addEventListener("click", () => {
      const app = this.elements.appRoot;
      const collapsed = app.classList.toggle("sidebar-collapsed");
      sidebarToggleButton.setAttribute("aria-expanded", String(!collapsed));
      sidebarToggleButton.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
      this.elements.sidebarToggleButton.hidden = false;
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "+" || e.key === "=") this.renderer?.zoomIn();
      if (e.key === "-") this.renderer?.zoomOut();
      if (e.key === "h" || e.key === "H") {
        const home = this.renderer?.findHomeCell();
        if (home) this.renderer.centerOn(home.x, home.y);
      }
      if (e.key === "Escape") {
        this.selectedCell = null;
        this.renderer?.markDirty();
        this._renderDetails(this.hoveredCell);
      }
    });
  }

  // ─── Session management ──────────────────────────────────────────────────────

  async _handleLogin() {
    const email    = this.elements.emailInput?.value?.trim();
    const password = this.elements.passwordInput?.value;
    if (!email || !password) return;

    this._setLoginBusy(true);
    this._showOverlay("Signing in...");

    try {
      // Auto-detect API version first
      const apiVersion = await this.api.resolveApiVersion();
      this.config = setViewerConfig({ ...this.config, apiVersion });
      this.api = new ApiClient(this.config);

      const session = await this.api.login(email, password);
      await this._applySession(session);
    } catch (err) {
      this._setLoginBusy(false);
      this._showStatus(err.message || "Login failed.");
      this._showOverlay(SIGNED_OUT_OVERLAY_MESSAGE);
    }
  }

  async _restoreSession(token) {
    this._showOverlay("Restoring session...");
    try {
      const apiVersion = await this.api.resolveApiVersion();
      this.config = setViewerConfig({ ...this.config, apiVersion });
      this.api = new ApiClient(this.config);

      const session = await this.api.refresh(token);
      await this._applySession(session);
    } catch {
      this._showOverlay(SIGNED_OUT_OVERLAY_MESSAGE);
    }
  }

  async _applySession(session) {
    this.session = session;
    const tokenKey = buildTokenStorageKey(this.config);
    localStorage.setItem(tokenKey, JSON.stringify({ token: session.token }));

    this._setLoginBusy(false);
    this._showStatus("");
    this._updateSessionUI();

    await this._startFullMapLoad(false);
  }

  _handleLogout() {
    const tokenKey = buildTokenStorageKey(this.config);
    localStorage.removeItem(tokenKey);

    if (this._loadAbortController) {
      this._loadAbortController.abort();
      this._loadAbortController = null;
    }

    this.session = null;
    this.renderer?.clearCells();
    this._updateSessionUI();
    this._hideProgress();
    this._showOverlay(SIGNED_OUT_OVERLAY_MESSAGE);
    this._renderDetails(null);
    this.elements.logoutButton.hidden = true;
    this.elements.loginForm.hidden = false;
    this.elements.findHomeButton.disabled = true;
    this.elements.refreshButton.disabled = true;
    this.elements.searchToggleButton.disabled = true;
    this.elements.searchInput.disabled = true;
    this._enableFilterControls(false);
    this._clearFilter();
  }

  _updateSessionUI() {
    const { session } = this;
    if (!session) return;

    this.elements.sessionName.textContent = session.user.username || "Signed in";
    this.elements.loginForm.hidden = true;
    this.elements.logoutButton.hidden = false;
    this.elements.sidebarToggleButton.hidden = false;
    this.elements.findHomeButton.disabled = false;
    this.elements.refreshButton.disabled = false;
    this.elements.searchToggleButton.disabled = false;
    this.elements.searchInput.disabled = false;
    this._enableFilterControls(true);
    this._showStatus("");

    // Show current world in session panel
    const worldEl = this.elements.sessionWorld;
    if (worldEl) {
      const worldName = session.map?.worldName || session.map?.worldid || null;
      if (worldName) {
        worldEl.textContent = `World: ${worldName}`;
        worldEl.hidden = false;
      } else {
        worldEl.hidden = true;
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

  // ─── Worlds & Leaderboard ───────────────────────────────────────────────────


  // ─── Map loading ─────────────────────────────────────────────────────────────

  async _startFullMapLoad(forceRefresh = false) {
    if (!this.session) return;

    // Abort any in-progress load
    if (this._loadAbortController) {
      this._loadAbortController.abort();
      this._loadAbortController = null;
    }

    const cacheKey = buildFullMapCacheKey(this.session.user.userid, this.session.map?.worldid || "");

    if (!forceRefresh) {
      // Restore from IndexedDB cache.  If the cache exists, show it and stop —
      // no background reload.  The user can click ↺ to fetch fresh data.
      try {
        const cached = await sessionCacheGet(cacheKey);
        if (cached?.cells?.length > 0) {
          this.renderer.clearCells();
          this.renderer.ingestCells(cached.cells);
          this._hideOverlay();
          this._updateSearchEntries();
          this._updateFilterCount();
          this._autoFindHome();
          this._showProgress(
            `Loaded from cache — ${cached.cells.length.toLocaleString()} cells. Use ↺ to fetch fresh data from server.`,
            cached.cells.length,
            cached.cells.length,
          );
          setTimeout(() => this._hideProgress(), 2500);
          return; // done — no server requests needed
        }
      } catch {
        // Cache miss or error — fall through to full load below
      }
    } else {
      // Force refresh: wipe the renderer and clear the saved cache
      this.renderer.clearCells();
      try { await sessionCacheDelete(cacheKey); } catch { /* ignore */ }
    }

    // ── Full load from server via /worldmapv2/getarea (10x10 chunks) ─────────
    // TODO: swap to generateAllCellIds + getMapCells once
    //       /worldmapv2/getcellsforviewer is deployed on the server.
    this._showOverlay(forceRefresh ? "Reloading map from server..." : "Loading map...");
    this._loadAbortController = new AbortController();
    const signal = this._loadAbortController.signal;

    const chunks = generateChunkCoords();
    const total  = chunks.length;
    this._loadTotal = total;
    this._loadDone  = 0;
    this._loadInProgress = true;

    this._showProgress("Loading map...", 0, total);

    const sem   = new Semaphore(MR2.concurrency);
    const token = this.session.token;

    const loadChunk = async ({ x, y }) => {
      if (signal.aborted) return;
      await sem.acquire();
      if (signal.aborted) { sem.release(); return; }

      try {
        const result = await this.api.getMapArea(token, x, y);
        if (!signal.aborted && result?.data) {
          this.renderer.ingestArea(result.data);
        }
      } catch {
        // Individual chunk errors are silently ignored; map remains partial
      } finally {
        sem.release();
        if (!signal.aborted) {
          this._loadDone++;
          this._showProgress(
            this._loadDone < total ? "Loading map..." : "Map loaded.",
            this._loadDone,
            total,
          );
          if (this._loadDone === total) {
            this._loadInProgress = false;
            this._onMapLoadComplete();
          }
        }
      }
    };

    Promise.all(chunks.map(loadChunk)).then(() => {
      if (!signal.aborted && this._loadDone < total) {
        this._loadInProgress = false;
        this._onMapLoadComplete();
      }
    });
  }

  _onMapLoadComplete() {
    this._hideOverlay();
    this._updateSearchEntries();
    this._updateFilterCount();
    this._autoFindHome();

    // Persist to IndexedDB cache
    if (this.session) {
      const cacheKey = buildFullMapCacheKey(this.session.user.userid, this.session.map?.worldid || "");
      const cells = [...this.renderer.cells.values()];
      sessionCacheSet(cacheKey, { cells, ts: Date.now() }).catch(() => {});
    }

    // Hide the progress bar after a short pause so the user sees "100%" briefly
    setTimeout(() => this._hideProgress(), 2500);
  }

  _autoFindHome() {
    const home = this.renderer?.findHomeCell();
    if (home) this.renderer.centerOn(home.x, home.y);
  }

  // ─── Progress UI ─────────────────────────────────────────────────────────────

  _showProgress(message, done, total) {
    const { loadProgress, loadProgressBar, loadProgressText } = this.elements;
    if (!loadProgress) return;
    loadProgress.hidden = false;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (loadProgressBar) loadProgressBar.style.width = `${pct}%`;
    if (loadProgressText) loadProgressText.textContent = `${message} ${done} / ${total} chunks (${pct}%)`;
  }

  _hideProgress() {
    if (this.elements.loadProgress) this.elements.loadProgress.hidden = true;
  }

  _showOverlay(message) {
    const overlay = this.elements.mapOverlay;
    if (!overlay) return;
    overlay.dataset.message = message;
    overlay.hidden = false;
  }

  _hideOverlay() {
    if (this.elements.mapOverlay) this.elements.mapOverlay.hidden = true;
  }

  // ─── Cell details panel ──────────────────────────────────────────────────────

  _renderDetails(cell) {
    const title   = this.elements.detailsTitle;
    const content = this.elements.detailsContent;
    if (!title || !content) return;

    if (!cell) {
      title.textContent = "No selection";
      content.innerHTML = "Hover or click a cell to inspect it.";
      return;
    }

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

    // Flinger range: main yard 0/4/6/8/10, outpost 0/1/2/3/4
    const flingerLv    = Number(f) || 0;
    const flingerRange = isHome
      ? [0, 4, 6, 8, 10][flingerLv] ?? 10
      : [0, 1, 2, 3, 4][flingerLv] ?? 4;

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
      ${outpostCount > 0 ? `<div class="detail-row"><span>Outposts</span><span>${outpostCount}</span></div>` : ""}
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

  // ─── Search ───────────────────────────────────────────────────────────────────

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

    this.searchMatches = this.searchEntries
      .filter((c) => c.n && c.n.toLowerCase().includes(query))
      .slice(0, SEARCH_RESULT_LIMIT);

    if (!this.searchMatches.length) {
      results.innerHTML = `<div class="search-result-item muted">No results</div>`;
      results.hidden = false;
      return;
    }

    results.innerHTML = this.searchMatches
      .map(
        (c, i) => `
        <button
          class="search-result-item"
          data-index="${i}"
          type="button"
        >${escapeHtml(c.n)} <span class="search-result-coords">(${c.x}, ${c.y})</span></button>
      `,
      )
      .join("");

    results.hidden = false;

    results.querySelectorAll(".search-result-item[data-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const cell = this.searchMatches[idx];
        if (cell) {
          this.renderer.centerOn(cell.x, cell.y);
          this.selectedCell = cell;
          this.renderer.selectedCell = cell;
          this.renderer.markDirty();
          this._renderDetails(cell);
          results.hidden = true;
          this.elements.searchInput.value = cell.n;
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
      if (this.filterOpen) filterPlayerInput?.focus();
    });

    filterPlayerInput?.addEventListener("input", () => {
      this._applyFilter();
      this._showFilterPlayerSuggestions();
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

    // Close filter panel if user clicks outside
    document.addEventListener("click", (e) => {
      if (!this.filterOpen) return;
      const bar = document.querySelector(".map-tool-bar");
      if (bar && !bar.contains(e.target)) {
        this.filterOpen = false;
        if (filterPanel) filterPanel.hidden = true;
        filterToggleButton?.setAttribute("aria-expanded", "false");
      }
    }, true);
  }

  _showFilterPlayerSuggestions() {
    const { filterPlayerInput, filterPlayerResults } = this.elements;
    if (!filterPlayerInput || !filterPlayerResults) return;

    const query = filterPlayerInput.value.trim().toLowerCase();
    if (!query) {
      filterPlayerResults.hidden = true;
      return;
    }

    const matches = this.searchEntries
      .filter((c) => c.n && c.n.toLowerCase().includes(query))
      .slice(0, 20);

    if (!matches.length) {
      filterPlayerResults.hidden = true;
      return;
    }

    filterPlayerResults.innerHTML = matches
      .map((c) => `<button class="search-result-item" data-name="${escapeHtml(c.n)}" type="button">${escapeHtml(c.n)}</button>`)
      .join("");

    filterPlayerResults.hidden = false;

    filterPlayerResults.querySelectorAll(".search-result-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        filterPlayerInput.value = btn.dataset.name;
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
    const playerName = (this.elements.filterPlayerInput?.value ?? "").trim().toLowerCase();

    const baseTypes = new Set();
    document.querySelectorAll("#filter-base-options input[type=checkbox]:checked")
      .forEach((cb) => baseTypes.add(cb.value));

    const terrainTypes = new Set();
    document.querySelectorAll("#filter-terrain-options input[type=checkbox]:checked")
      .forEach((cb) => terrainTypes.add(cb.value));

    const towerBonusRange    = this._readBonusRange("tower-bonus-min",    "tower-bonus-max");
    const resourceBonusRange = this._readBonusRange("resource-bonus-min", "resource-bonus-max");

    const hasAny = playerName || baseTypes.size || terrainTypes.size || towerBonusRange || resourceBonusRange;
    this.renderer?.setFilter(hasAny ? { playerName, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange } : null);

    this._updateFilterCount();
  }

  _clearFilter() {
    if (this.elements.filterPlayerInput) this.elements.filterPlayerInput.value = "";
    if (this.elements.filterPlayerResults) this.elements.filterPlayerResults.hidden = true;
    document.querySelectorAll("#filter-base-options input[type=checkbox], #filter-terrain-options input[type=checkbox]")
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
