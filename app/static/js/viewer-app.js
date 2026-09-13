import { ApiClient } from "./api-client.js";
import { MapRenderer } from "./map-renderer.js";
import {
  MR2,
  MapRoomVersion,
  STABLE_VIEWER_CONFIG,
  SERVER_SELECTION_STORAGE_KEY,
  SEARCH_RESULT_LIMIT,
  buildTokenStorageKey,
  buildTerrainCacheKey,
  buildSnapshotCacheKey,
  buildHomePosKey,
  cellKey,
  escapeHtml,
  getLocalViewerConfig,
  getTerrainLabel,
  isWater,
  sessionCacheGet,
  sessionCacheSet,
  setViewerConfig,
} from "./shared.js";

const SIGNED_OUT_OVERLAY_MESSAGE = "Please log in.";

// This viewer's sibling for the other map room version — linked when an
// account's world doesn't match the one this viewer is built for.
const OTHER_VIEWER_URL = "https://bymr-maproom3-viewer.chibbluffy.fyi/";
const WRONG_MAP_VERSION_OVERLAY_MESSAGE = "This account is not on a Map Room 2 world.";
const WRONG_MAP_VERSION_MESSAGE =
  `${WRONG_MAP_VERSION_OVERLAY_MESSAGE} Please make sure it is on an ` +
  `upgraded map room, or try the other map viewer: ` +
  `<a href="${OTHER_VIEWER_URL}" target="_blank" rel="noopener">${OTHER_VIEWER_URL}</a>`;

// Compact number formatter: 1234567 → "1.2M", 5000 → "5K", 400 → "400"
// Negative values are clamped to 0 — they appear in the game DB as delta artefacts.
function _fmtNum(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
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
    this._filterPlayers = new Map();  // uid → name; drives multi-player highlight
    this._apiVersionLocked = false;   // true when user has manually pinned API version

    // ── World-load state ─────────────────────────────────────────────────────
    this._worldLoaded      = false;  // true once terrain+snapshot have loaded at least once
    this._terrainBytes     = null;   // cached raw terrain blob, reused on every snapshot poll
    this._terrainEtag      = null;
    this._snapshotEtag     = null;
    this._worldLoadPromise = null;   // in-flight load — lets concurrent callers share one fetch
    // Bumped on every login and logout. A load in flight when the generation
    // moves on (a different account logs in, or the session ends) discards
    // its result instead of writing a now-stale session's data into the
    // renderer — see _bumpWorldLoadGeneration() and _doLoadWorld().
    this._worldLoadGeneration = 0;
    // Bumped on every cell click so a slow, superseded getarea reply can't
    // clobber a later selection's detail panel.
    this._enrichToken = 0;
    // Kept for the tnb/export page, which polls these directly rather than
    // hooking a viewer-app event — see the compatibility shims near the
    // bottom of the map-loading section.
    this._bgLoadActive = false;

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
      sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
      filterToggleButton:   document.getElementById("filter-toggle-button"),
      filterPanel:          document.getElementById("filter-panel"),
      filterPlayerInput:    document.getElementById("filter-player-input"),
      filterPlayerResults:  document.getElementById("filter-player-results"),
      filterClearButton:    document.getElementById("filter-clear-button"),
      filterMatchCount:     document.getElementById("filter-match-count"),
      bgLoadButton:            document.getElementById("bg-load-button"),
      serverApiVersionInput:   document.getElementById("server-apiversion-input"),
    };
  }

  async start() {
    // Move dropdown elements to <body> so position:fixed works with viewport coords.
    // backdrop-filter on .map-tool-panel creates a new containing block for fixed
    // descendants, making getBoundingClientRect() offsets wrong when they're inside it.
    [this.elements.searchResults, this.elements.filterPlayerResults]
      .forEach(el => { if (el) document.body.appendChild(el); });

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
          this._applyCustomServerConfig(parsed.host, parsed.port, parsed.apiVersion || "");
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
    const { serverSelect, serverCustomFields, serverHostInput, serverPortInput, serverApiVersionInput } = this.elements;
    if (!serverSelect) return;

    serverSelect.addEventListener("change", () => {
      const val = serverSelect.value;
      serverCustomFields.hidden = val !== "custom";
      this._onServerSelectionChange(val);
    });

    [serverHostInput, serverPortInput, serverApiVersionInput].forEach((input) => {
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
      this._apiVersionLocked = false;
      this.config = setViewerConfig({ ...STABLE_VIEWER_CONFIG });
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection }));
    } else if (selection === "custom") {
      const host       = this.elements.serverHostInput?.value?.trim() || "127.0.0.1";
      const port       = this.elements.serverPortInput?.value || "3001";
      const apiVersion = this.elements.serverApiVersionInput?.value?.trim() || "";
      this._applyCustomServerConfig(host, port, apiVersion);
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection, host, port, apiVersion }));
    } else {
      this._apiVersionLocked = false;
      this.config = setViewerConfig(getLocalViewerConfig());
      localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify({ selection }));
    }

    this.api = new ApiClient(this.config);
  }

  _applyCustomServerConfig(host, port, apiVersion = "") {
    // If host already includes a protocol, use it verbatim (port field is ignored).
    // Otherwise build http://host:port for localhost/LAN usage.
    let base;
    if (/^https?:\/\//i.test(host)) {
      base = host.replace(/\/+$/, "");
    } else {
      base = `http://${host}:${port}`;
    }
    const overrideVersion = apiVersion?.trim();
    this._apiVersionLocked = !!overrideVersion;
    this.config = setViewerConfig({
      bymBaseUrl: base,
      cdnBaseUrl: base,
      ...(overrideVersion ? { apiVersion: overrideVersion } : {}),
    });
    if (this.elements.serverHostInput)       this.elements.serverHostInput.value = host;
    if (this.elements.serverPortInput)       this.elements.serverPortInput.value = port;
    if (this.elements.serverApiVersionInput) this.elements.serverApiVersionInput.value = apiVersion || "";
    if (this.elements.serverCustomFields)    this.elements.serverCustomFields.hidden = false;
    if (this.elements.serverSelect)          this.elements.serverSelect.value = "custom";
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

    // Sole reload control — combines what used to be two separate buttons
    // (refresh-button and bg-load-button). bg-load-button no longer exists
    // in the DOM; _startBackgroundLoad()/_bgLoadActive/etc. are kept only
    // for the tnb/export page, which calls them directly as methods rather
    // than through a click on that button.
    refreshButton?.addEventListener("click", () => {
      if (this.session) this._refreshMap();
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
      // Auto-detect API version unless the user has manually pinned one
      if (!this._apiVersionLocked) {
        const apiVersion = await this.api.resolveApiVersion();
        this.config = setViewerConfig({ ...this.config, apiVersion });
        this.api = new ApiClient(this.config);
      }

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
      if (!this._apiVersionLocked) {
        const apiVersion = await this.api.resolveApiVersion();
        this.config = setViewerConfig({ ...this.config, apiVersion });
        this.api = new ApiClient(this.config);
      }

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

    this._bumpWorldLoadGeneration();
    this._worldLoaded      = false;
    this._terrainBytes     = null;
    this._terrainEtag      = null;
    this._snapshotEtag     = null;
    this._bgLoadActive     = false;
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
  //
  // The whole world loads in two requests — /worldmapv2/terrain (a static
  // byte-per-cell height map) and /worldmapv2/snapshot (every occupied cell) —
  // instead of crawling the map in 10x10 chunks. Unattacked wild monster camps
  // (most of the map) are reconstructed client-side from pure functions of
  // (x, y, worldid); see MapRenderer.loadWorld(). Both endpoints support
  // ETag/If-None-Match revalidation server-side, but If-None-Match isn't on
  // the server's CORS Access-Control-Allow-Headers list, so sending it gets
  // the whole request blocked client-side with a generic network error — see
  // ApiClient.getTerrain()'s comment. Every load fetches the full body;
  // IndexedDB still gives an instant paint from the last session while that
  // fetch is in flight, it just can't be cheaply revalidated first.

  // Bumps whenever a session boundary is crossed (login or logout) so a load
  // still in flight from before that point can tell it's been superseded.
  // Also drops any in-flight promise reference so the next _loadWorld() call
  // starts fresh instead of coalescing onto (and awaiting the result of) a
  // load that belongs to a different account or no account at all.
  _bumpWorldLoadGeneration() {
    this._worldLoadGeneration++;
    this._worldLoadPromise = null;
  }

  // Called on login / session restore.
  async _initMapLoad() {
    if (!this.session) return;
    this._bumpWorldLoadGeneration();

    if (!this.session.map?.worldid) await this._resolveWorldId();

    // terrain/snapshot would just 400 "Unknown worldid" for an MR3 account
    // (their world exists, it's just not tagged V2) — check up front against
    // the public world list and point the player at the right viewer instead
    // of a doomed fetch.
    // Covers both "wrong map room version" and "no world at all" — see
    // _isWrongMapVersion()'s doc comment.
    if (await this._isWrongMapVersion()) {
      this._showStatus(WRONG_MAP_VERSION_OVERLAY_MESSAGE);
      this._showOverlay(WRONG_MAP_VERSION_MESSAGE);
      return;
    }

    this._centerOnStoredHome();
    await this._loadWorld({ useCache: true });
  }

  // Cross-references the resolved worldid against the public world list to
  // confirm it's actually a Map Room 2 world. True for "wrong version", "no
  // world at all", or anything else that isn't a confirmed MR2 world; false
  // only once a match is confirmed. If the check itself can't complete (e.g.
  // a network error), returns false so the normal load path runs and fails
  // on its own terms rather than blocking on an inconclusive check.
  async _isWrongMapVersion() {
    const worldid = this.session.map?.worldid;
    if (!worldid) return true;

    let worlds;
    try {
      ({ worlds } = await this.api.getWorlds());
    } catch {
      return false;
    }

    const world = (worlds || []).find((candidate) => candidate.uuid === worldid);
    return !(world && world.map_version === MapRoomVersion.V2);
  }

  // Neither /player/getinfo nor /bm/getnewmap expose the player's worldid —
  // it's only ever returned by /base/load, so that's what we fall back to.
  // This also runs the game's own one-time login side effects (Town Hall
  // reward grants, invasion wave rollover), same as the real client's first
  // base load: rewards land the moment the player's next real load would
  // have granted them anyway, and the invasion rollover happens once per
  // monthly cycle regardless of which client triggers the first load that
  // cycle — neither changes anything the player would perceive differently.
  //
  // Deliberately NOT cached across logins: a player can relocate to a
  // different (still perfectly valid) MR2 world, and a cached worldid from
  // before that move wouldn't error — it'd just silently load the wrong
  // world with no indication anything was off. Always resolving fresh on
  // login is the only way to guarantee correctness here, so this runs once
  // per login/session-restore rather than once per account.
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

  // Shared by _initMapLoad, the refresh button, the snapshot poll, and
  // export.js's ensureBackgroundLoadDone() — concurrent callers coalesce onto
  // one in-flight fetch rather than firing duplicate requests.
  _loadWorld(opts = {}) {
    if (this._worldLoadPromise) return this._worldLoadPromise;
    this._worldLoadPromise = this._doLoadWorld(opts).finally(() => {
      this._worldLoadPromise = null;
    });
    return this._worldLoadPromise;
  }

  async _doLoadWorld({ useCache = false, force = false, retriedWorldId = false } = {}) {
    if (!this.session || !this.renderer) return;
    const myGeneration = this._worldLoadGeneration;

    const worldid = this.session.map?.worldid || "";
    const token   = this.session.token;
    this.renderer.myUserId = this.session.user.userid;

    let terrainBytes = null;
    let snapshot      = null;

    if (useCache && !force) {
      try {
        const [cachedTerrain, cachedSnapshot] = await Promise.all([
          sessionCacheGet(buildTerrainCacheKey(worldid)),
          sessionCacheGet(buildSnapshotCacheKey(worldid)),
        ]);
        // A newer login (or a logout) superseded this load while the cache
        // read was in flight — abandon it rather than write a stale result.
        if (myGeneration !== this._worldLoadGeneration) return;
        if (cachedTerrain?.bytes)   { terrainBytes = cachedTerrain.bytes;   this._terrainEtag  = cachedTerrain.etag ?? null; }
        if (cachedSnapshot?.snapshot) { snapshot   = cachedSnapshot.snapshot; this._snapshotEtag = cachedSnapshot.etag ?? null; }

        // Paint immediately from cache while the network call below revalidates.
        if (terrainBytes && snapshot) {
          this.renderer.loadWorld(terrainBytes, snapshot);
          this._terrainBytes = terrainBytes;
          this._worldLoaded  = true;
          this._hideOverlay();
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
        this.api.getTerrain(token, worldid).then(r => { bump(); return r; }),
        this.api.getSnapshot(token, worldid).then(r => { bump(); return r; }),
      ]);
    } catch (err) {
      // worldid is resolved once at login and held in memory for the rest of
      // the session — if the player relocates worlds mid-session (or the
      // in-memory value is otherwise stale), the world it names becomes
      // genuinely unknown to the server. Self-heal once by re-resolving it
      // fresh rather than getting permanently stuck on a defunct world.
      if (String(err?.message || "").includes("Unknown worldid") && !retriedWorldId) {
        this.session.map = { ...this.session.map, worldid: "" };
        await this._resolveWorldId();
        if (this.session.map?.worldid) {
          return this._doLoadWorld({ useCache, force: true, retriedWorldId: true });
        }
      }
      this._showStatus(err?.message || "Failed to load the world map.");
      // The overlay was switched on above ("Loading world map...") and never
      // gets turned back off past this point otherwise — leaving it stuck
      // there indefinitely. If a map is already showing, just reveal it
      // again (the status line above already carries the error); if this
      // was the very first load, show the error in the overlay itself since
      // there's nothing else to reveal.
      if (this._worldLoaded) this._hideOverlay();
      else this._showOverlay(err?.message || "Failed to load the world map.");
      throw err;
    } finally {
      setTimeout(() => this._hideProgress(), 600);
    }

    // Same check as above, now that the network round-trip has also had time
    // for a newer login or a logout to come in behind this call.
    if (myGeneration !== this._worldLoadGeneration) return;

    let changed = false;

    if (terrainResult.bytes) {
      terrainBytes      = terrainResult.bytes;
      this._terrainEtag = terrainResult.etag;
      changed = true;
      sessionCacheSet(buildTerrainCacheKey(worldid), { bytes: terrainBytes, etag: this._terrainEtag }).catch(() => {});
    }

    if (snapshotResult.snapshot) {
      snapshot            = snapshotResult.snapshot;
      this._snapshotEtag  = snapshotResult.etag;
      changed = true;
      sessionCacheSet(buildSnapshotCacheKey(worldid), { snapshot, etag: this._snapshotEtag }).catch(() => {});
    }

    if (!terrainBytes || !snapshot) {
      // Shouldn't happen — a successful fetch always returns a body — but
      // guard against it rather than proceed with a half-built world.
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
    this._updateSearchEntries();
    this._updateFilterCount();
    this._autoFindHome();
  }

  // Refresh button (↺): force a full revalidation right now. No automatic
  // polling — refreshing is deliberately only ever triggered by this click.
  async _refreshMap() {
    if (!this.session) return;
    this.selectedCell = null;
    try {
      await this._loadWorld({ force: true });
    } catch { /* _doLoadWorld already surfaced a status message */ }
  }

  // Bulk snapshot/terrain intentionally omit per-viewer/live fields —
  // resources, monsters, truce, and online/under-attack lock state (see the
  // MR2 Bulk Map Endpoints wiki). Backfill them for the clicked cell with a
  // single getarea call scoped to just that cell.
  async _enrichSelectedCell(cell) {
    if (!cell || !this.session || cell.uid === undefined) return; // water cell — nothing to enrich

    const token   = this.session.token;
    const request = ++this._enrichToken;

    try {
      const result = await this.api.getMapArea(token, cell.x, cell.y);
      if (request !== this._enrichToken) return; // a later click superseded this one

      const fresh = result?.data?.[cell.x]?.[cell.y];
      if (!fresh) return;

      const merged = { ...cell, ...fresh, x: cell.x, y: cell.y };
      this.renderer.cells.set(cellKey(cell.x, cell.y), merged);

      if (this.selectedCell?.x === cell.x && this.selectedCell?.y === cell.y) {
        this.selectedCell = merged;
        this.renderer.selectedCell = merged;
        this._renderDetails(merged);
      }
    } catch { /* keep showing the bulk-derived data on failure */ }
  }

  // ── tnb/export compatibility shims ─────────────────────────────────────────
  // export.js polls these directly rather than hooking a viewer-app event, so
  // their names and rough behaviour are kept even though the world now loads
  // in two requests instead of crawling chunks in the background.

  _isFullMapLoaded() {
    return this._worldLoaded;
  }

  async _startBackgroundLoad() {
    if (this._worldLoaded) return;
    this._bgLoadActive = true;
    this._setBgLoadButtonState(true);
    try {
      await this._loadWorld({ useCache: true });
    } catch { /* _doLoadWorld already surfaced a status message */ }
    finally {
      this._bgLoadActive = false;
      this._setBgLoadButtonState(false);
    }
  }

  _stopBackgroundLoad() {
    // Nothing cancellable left to stop — the bulk load is two requests, not
    // a long crawl — but keep this so callers relying on it don't break.
    this._bgLoadActive = false;
    this._setBgLoadButtonState(false);
  }

  _toggleBackgroundLoad() {
    if (this._bgLoadActive) this._stopBackgroundLoad();
    else this._startBackgroundLoad();
  }

  _setBgLoadButtonState(active) {
    const btn = this.elements.bgLoadButton;
    if (!btn) return;
    btn.classList.toggle("bg-load-button--active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.title = active ? "Loading..." : "Reload the full map from the server";
    btn.setAttribute("aria-label", btn.title);
    const label = btn.querySelector(".bg-load-label");
    if (label) label.textContent = active ? "Loading..." : "Reload map";
  }

  _autoFindHome() {
    const home = this.renderer?.findHomeCell();
    if (home) {
      this._storeHomePos(home.x, home.y);
      this.renderer.centerOn(home.x, home.y);
    }
  }

  // Center the camera on a cell. The whole world is already resident, so
  // unlike the old demand-loader this never needs to fetch anything.
  _jumpTo(cx, cy) {
    this.renderer.centerOn(cx, cy);
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

  // innerHTML rather than textContent so WRONG_MAP_VERSION_MESSAGE's link can
  // render — every caller passes a static, trusted string, never user input.
  _showOverlay(html) {
    const overlay = this.elements.mapOverlay;
    if (!overlay) return;
    if (this.elements.mapOverlayMessage) this.elements.mapOverlayMessage.innerHTML = html;
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

  // The whole world is always loaded once _worldLoaded is true, so outpost
  // counts are exact — no more "partial load" hedge needed here.
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
