import { ApiClient } from "./api-client.js";
import { MapRenderer } from "./map-renderer.js";
import {
  MR2,
  STABLE_VIEWER_CONFIG,
  SERVER_SELECTION_STORAGE_KEY,
  SEARCH_RESULT_LIMIT,
  buildTokenStorageKey,
  buildFullMapCacheKey,
  buildLoadedChunksCacheKey,
  buildHomePosKey,
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

    // ── Demand-load state ────────────────────────────────────────────────────
    // Set of "x,y" chunk-origin strings already fetched this session
    this._loadedChunks   = new Set();
    // Chunks currently in-flight — prevents duplicate requests while panning
    this._pendingChunks  = new Set();
    // AbortController for the viewport / full-load operations
    this._loadAbortController = null;
    // AbortController for background full-map load
    this._bgAbortController  = null;
    this._bgLoadActive = false;
    // Debounce timer for persisting the loaded-chunks Set to IndexedDB
    this._saveChunksTimer = null;
    // Debounce timer for persisting cell data to IndexedDB
    this._saveCellsTimer  = null;

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
      bgLoadButton:         document.getElementById("bg-load-button"),
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

    // Demand-load new chunks as the user pans or zooms
    this.renderer.onViewportChanged = () => {
      if (this.session) this._loadViewport();
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
      if (home) this._jumpTo(home.x, home.y);
    });

    refreshButton?.addEventListener("click", () => {
      if (this.session) this._refreshMap();
    });

    this.elements.bgLoadButton?.addEventListener("click", () => {
      if (this.session) this._toggleBackgroundLoad();
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
        if (home) this._jumpTo(home.x, home.y);
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

    await this._initMapLoad();
  }

  _handleLogout() {
    const tokenKey = buildTokenStorageKey(this.config);
    localStorage.removeItem(tokenKey);

    if (this._loadAbortController) { this._loadAbortController.abort(); this._loadAbortController = null; }
    if (this._bgAbortController)   { this._bgAbortController.abort();   this._bgAbortController   = null; }
    this._bgLoadActive  = false;
    this._loadedChunks  = new Set();
    this._pendingChunks = new Set();
    clearTimeout(this._saveChunksTimer);
    clearTimeout(this._saveCellsTimer);
    this._setBgLoadButtonState(false);

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
    if (this.elements.bgLoadButton) this.elements.bgLoadButton.disabled = true;
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
    if (this.elements.bgLoadButton) this.elements.bgLoadButton.disabled = false;
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

  // Called on login / session restore.  Restores from cache if available,
  // then demand-loads any visible chunks that aren't already cached.
  async _initMapLoad() {
    if (!this.session) return;

    const uid     = this.session.user.userid;
    const worldid = this.session.map?.worldid || "";
    const cellsKey  = buildFullMapCacheKey(uid, worldid);
    const chunksKey = buildLoadedChunksCacheKey(uid, worldid);

    try {
      const [cachedCells, cachedChunks] = await Promise.all([
        sessionCacheGet(cellsKey),
        sessionCacheGet(chunksKey),
      ]);

      if (cachedCells?.cells?.length > 0) {
        this.renderer.clearCells();
        this.renderer.ingestCells(cachedCells.cells);
        this._loadedChunks = new Set(cachedChunks?.chunks ?? []);
        this._hideOverlay();
        this._updateSearchEntries();
        this._updateFilterCount();
        this._autoFindHome();
        this._showProgress(
          `Restored from cache — ${this._loadedChunks.size} chunks loaded. Pan to explore; use ↺ to reset.`,
          this._loadedChunks.size,
          this._loadedChunks.size,
        );
        setTimeout(() => this._hideProgress(), 3000);
        // Load any viewport gaps not already in the chunk cache
        await this._loadViewport();
        return;
      }
    } catch { /* no cache or error — fresh load */ }

    // No cache: center on stored home position if known, then load the viewport.
    // After the first load completes, try to center on the actual home cell now
    // that it's in the renderer — only done once here, never during panning.
    this._loadedChunks = new Set();
    this._centerOnStoredHome();
    this._showOverlay("Loading area around your base...");
    await this._loadViewport();
    this._autoFindHome();
  }

  // Refresh button (↺): clears cache, returns to home, reloads viewport only.
  async _refreshMap() {
    if (!this.session) return;

    if (this._bgAbortController) {
      this._bgAbortController.abort();
      this._bgAbortController = null;
      this._bgLoadActive = false;
      this._setBgLoadButtonState(false);
    }
    if (this._loadAbortController) {
      this._loadAbortController.abort();
      this._loadAbortController = null;
    }

    const uid     = this.session.user.userid;
    const worldid = this.session.map?.worldid || "";
    try {
      await Promise.all([
        sessionCacheDelete(buildFullMapCacheKey(uid, worldid)),
        sessionCacheDelete(buildLoadedChunksCacheKey(uid, worldid)),
      ]);
    } catch { /* ignore */ }

    this._loadedChunks  = new Set();
    this._pendingChunks = new Set();
    this.renderer.clearCells();
    this.selectedCell = null;

    this._centerOnStoredHome();
    this._showOverlay("Reloading area around your base...");
    await this._loadViewport();
  }

  // Demand-loads chunks currently visible in the viewport that haven't been
  // fetched yet.  Called on login, pan, zoom, and after refresh.
  //
  // Key design: in-flight fetches are NEVER aborted mid-request.  Aborting
  // removes a key from _pendingChunks without adding it to _loadedChunks,
  // which leaves a permanent gap in the map.  Instead we only cancel the
  // queue gate (so we stop dispatching new requests from the old call), while
  // letting any already-started requests finish and commit their data.
  async _loadViewport() {
    if (!this.session || !this.renderer) return;

    // Cancel the previous queue gate only — does NOT abort in-flight fetches
    if (this._loadAbortController) {
      this._loadAbortController.abort();
    }
    this._loadAbortController = new AbortController();
    const signal = this._loadAbortController.signal;

    // Snapshot the visible area right now
    const visibleKeys = this.renderer.getVisibleChunkKeys(2);
    const toLoad = [...visibleKeys].filter(
      k => !this._loadedChunks.has(k) && !this._pendingChunks.has(k)
    );

    if (!toLoad.length) {
      this._hideOverlay();
      return;
    }

    // Sort by distance from viewport centre so nearest chunks load first.
    // Convert viewport centre from world pixels to cell coordinates so it's
    // on the same scale as the chunk origin keys (which are cell indices).
    const { viewX, viewY, zoom } = this.renderer;
    const W    = this.renderer.canvas.clientWidth;
    const H    = this.renderer.canvas.clientHeight;
    const wcx  = (viewX + W / zoom / 2) / MR2.hexColStep;  // cell X
    const wcy  = (viewY + H / zoom / 2) / MR2.hexRowStep;  // cell Y
    toLoad.sort((a, b) => {
      const [ax, ay] = a.split(",").map(Number);
      const [bx, by] = b.split(",").map(Number);
      return (Math.abs(ax - wcx) + Math.abs(ay - wcy)) -
             (Math.abs(bx - wcx) + Math.abs(by - wcy));
    });

    // Local counters — each _loadViewport call owns its own progress state
    // so concurrent/aborted calls can't corrupt each other's numbers.
    let done = 0;
    const total = toLoad.length;
    const onProgress = () => {
      done++;
      this._showProgress("Fetching", done, total);
    };

    this._showProgress("Fetching", 0, total);

    const sem   = new Semaphore(8);
    const token = this.session.token;

    // Fire all, but skip queuing new work if the gate was cancelled
    await Promise.all(toLoad.map(key => {
      if (signal.aborted) return Promise.resolve();
      return this._fetchChunk(key, token, sem, false, onProgress);
    }));

    if (!signal.aborted) {
      this._hideOverlay();
      this._updateSearchEntries();
      this._updateFilterCount();
      this._persistCellsDebounced();
      setTimeout(() => this._hideProgress(), 1500);
    }
  }

  // Core chunk fetch.  Never aborted once started — abort logic lives in
  // _loadViewport's gate, not here.  Both viewport and background loaders use this.
  // onProgress is an optional callback owned by the caller (not instance state).
  async _fetchChunk(key, token, sem, isBg, onProgress = null) {
    if (this._loadedChunks.has(key) || this._pendingChunks.has(key)) return;

    this._pendingChunks.add(key);
    await sem.acquire();

    const [x, y] = key.split(",").map(Number);
    try {
      const result = await this.api.getMapArea(token, x, y);
      if (result?.data) {
        this.renderer.ingestArea(result.data);
        this._loadedChunks.add(key);
        this._persistChunksDebounced();
      }
    } catch { /* silently skip failed chunks */ }
    finally {
      sem.release();
      this._pendingChunks.delete(key);
      if (!isBg && onProgress) onProgress();
    }
  }

  // Background full-map load — low priority (concurrency 4), cancellable.
  async _startBackgroundLoad() {
    if (!this.session || this._bgLoadActive) return;

    this._bgAbortController = new AbortController();
    const signal = this._bgAbortController.signal;
    this._bgLoadActive = true;
    this._setBgLoadButtonState(true);

    const allChunks = generateChunkCoords(); // sorted centre-out
    const toLoad    = allChunks.filter(({ x, y }) => {
      const k = `${x},${y}`;
      return !this._loadedChunks.has(k) && !this._pendingChunks.has(k);
    });

    const token  = this.session.token;
    const sem    = new Semaphore(4);
    let done = 0;
    const total  = toLoad.length;

    this._showProgress("Background loading", 0, total);

    await Promise.all(toLoad.map(async ({ x, y }) => {
      if (signal.aborted) return;
      const key = `${x},${y}`;
      await this._fetchChunk(key, token, sem, true);
      if (!signal.aborted) {
        done++;
        if (done % 50 === 0 || done === total) {
          this._showProgress("Background loading", done, total);
        }
      }
    }));

    this._bgLoadActive = false;
    this._bgAbortController = null;
    this._setBgLoadButtonState(false);

    if (!signal.aborted) {
      this._updateSearchEntries();
      this._updateFilterCount();
      this._persistCellsDebounced();
      this._showProgress("Full map loaded.", total, total);
      setTimeout(() => this._hideProgress(), 2500);
    }
  }

  _stopBackgroundLoad() {
    if (this._bgAbortController) {
      this._bgAbortController.abort();
      this._bgAbortController = null;
    }
    this._bgLoadActive = false;
    this._setBgLoadButtonState(false);
    this._hideProgress();
  }

  _toggleBackgroundLoad() {
    if (this._bgLoadActive) {
      this._stopBackgroundLoad();
    } else {
      this._startBackgroundLoad();
    }
  }

  _setBgLoadButtonState(active) {
    const btn = this.elements.bgLoadButton;
    if (!btn) return;
    btn.classList.toggle("bg-load-button--active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.title = active
      ? "Cancel background load"
      : "Load the entire 800×800 map in the background";
    btn.setAttribute("aria-label", btn.title);
    const label = btn.querySelector(".bg-load-label");
    if (label) label.textContent = active ? "Stop loading" : "Load full map";
  }

  _onMapLoadComplete() {
    // Kept for any future full-load path
    this._hideOverlay();
    this._updateSearchEntries();
    this._updateFilterCount();
    this._autoFindHome();
    this._persistCellsDebounced();
    setTimeout(() => this._hideProgress(), 2500);
  }

  _autoFindHome() {
    const home = this.renderer?.findHomeCell();
    if (home) {
      this._storeHomePos(home.x, home.y);
      this.renderer.centerOn(home.x, home.y);
    }
  }

  // Center the camera on a cell and immediately load any unloaded chunks
  // that are now visible.  Use this for all programmatic jumps so the
  // destination area is always filled in, even near map edges.
  _jumpTo(cx, cy) {
    this.renderer.centerOn(cx, cy);
    this._loadViewport();
  }

  _storeHomePos(x, y) {
    if (!this.session) return;
    const key = buildHomePosKey(this.session.user.userid, this.session.map?.worldid || "");
    localStorage.setItem(key, JSON.stringify({ x, y }));
  }

  _centerOnStoredHome() {
    if (!this.renderer || !this.session) return;
    const key = buildHomePosKey(this.session.user.userid, this.session.map?.worldid || "");
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "null");
      if (stored?.x != null && stored?.y != null) {
        this.renderer.centerOn(stored.x, stored.y);
        return;
      }
    } catch { /* ignore */ }
    // No stored position — centre on the map
    this.renderer.centerOn(MR2.mapWidth / 2, MR2.mapHeight / 2);
  }

  // Debounced IndexedDB saves — avoids hammering storage on every chunk
  _persistChunksDebounced() {
    clearTimeout(this._saveChunksTimer);
    this._saveChunksTimer = setTimeout(() => {
      if (!this.session) return;
      const key = buildLoadedChunksCacheKey(this.session.user.userid, this.session.map?.worldid || "");
      sessionCacheSet(key, { chunks: [...this._loadedChunks] }).catch(() => {});
    }, 2000);
  }

  _persistCellsDebounced() {
    clearTimeout(this._saveCellsTimer);
    this._saveCellsTimer = setTimeout(() => {
      if (!this.session) return;
      const key   = buildFullMapCacheKey(this.session.user.userid, this.session.map?.worldid || "");
      const cells = [...this.renderer.cells.values()];
      sessionCacheSet(key, { cells, ts: Date.now() }).catch(() => {});
    }, 3000);
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

  _isFullMapLoaded() {
    // 800×800 map with 10×10 chunks = 6400 total chunks
    return this._loadedChunks.size >= 6400;
  }

  _formatOutpostCount(count) {
    if (this._isFullMapLoaded()) return String(count);
    // Partial load — make it clear the count may be incomplete
    return `${count} loaded`;
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

    // One entry per player.  If their home base is loaded, jump there.
    // Otherwise jump to the outpost closest to the centroid of their loaded
    // outposts — this lands you in the middle of their cluster, from which
    // their home base can usually be found by panning nearby.
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

    const flingerLevels = new Set();
    document.querySelectorAll("#filter-flinger-options input[type=checkbox]:checked")
      .forEach((cb) => flingerLevels.add(Number(cb.value)));

    const hasAny = playerName || baseTypes.size || terrainTypes.size || towerBonusRange || resourceBonusRange || flingerLevels.size;
    this.renderer?.setFilter(hasAny ? { playerName, baseTypes, terrainTypes, towerBonusRange, resourceBonusRange, flingerLevels } : null);

    this._updateFilterCount();
  }

  _clearFilter() {
    if (this.elements.filterPlayerInput) this.elements.filterPlayerInput.value = "";
    if (this.elements.filterPlayerResults) this.elements.filterPlayerResults.hidden = true;
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
