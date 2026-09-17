import {
  buildBymUrl,
  buildSessionPayload,
  extractErrorMessage,
  fetchJson,
  getViewerConfig,
  normalizeApiVersion,
  parseJsonPayload,
} from "./shared.js";

export class ApiClient {
  constructor(config = getViewerConfig()) {
    this.config = config;
  }

  async resolveApiVersion() {
    const probeVersion = "__viewer_probe__";
    const probeUrl = buildBymUrl(`/api/${probeVersion}/player/getinfo`, null, this.config);

    try {
      await fetchJson(probeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams({ sessionType: "game" }),
      });
    } catch (error) {
      const fromProbe = this.extractApiVersion(error?.message || "");
      if (fromProbe) return fromProbe;
    }

    try {
      const response = await fetch(buildBymUrl("/init", null, this.config), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({}),
      });
      const payload = parseJsonPayload(await response.text());
      const fromInit = this.extractApiVersion(extractErrorMessage(payload) || "");
      if (fromInit) return fromInit;
    } catch {
      // ignore
    }

    return normalizeApiVersion(this.config.apiVersion);
  }

  async login(email, password) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({ email, password, sessionType: "game" }),
    });

    const map = await this.getMapMeta(loginResponse.token);
    return buildSessionPayload(loginResponse, map);
  }

  async refresh(token) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({ token, sessionType: "game" }),
    });

    const map = await this.getMapMeta(loginResponse.token);
    return buildSessionPayload(loginResponse, map);
  }

  async getMapMeta(token) {
    return fetchJson(this.buildApiUrl("/bm/getnewmap"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(),
    });
  }

  /** Only client-callable source of worldid — the same /base/load call the real client makes on first login. */
  async getOwnSave(token, userid) {
    return fetchJson(buildBymUrl("/base/load", null, this.config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({ type: "build", userid: String(userid), baseid: "0", mapversion: "2" }),
    });
  }

  /** Single-cell live detail (resources/monsters/truce/lock state), for click-to-enrich. Returns { error, x, y, data }. */
  async getMapArea(token, x, y) {
    return fetchJson(buildBymUrl("/worldmapv2/getarea", null, this.config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({ x: String(x), y: String(y), sendresources: "0" }),
    });
  }

  /** Bulk terrain height map (640,000 bytes, index x*800+y), via server.py's own SQLite-backed copy. Returns { bytes }. */
  async getTerrain(worldid) {
    const response = await fetch(`/api/terrain?world=${encodeURIComponent(worldid)}`);
    if (!response.ok) {
      const payload = parseJsonPayload(await response.text());
      throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    }
    const buffer = await response.arrayBuffer();
    return { bytes: new Uint8Array(buffer) };
  }

  /** Bulk occupancy snapshot (every home/outpost/attacked wild camp + owners). Returns { snapshot }. */
  async getSnapshot(worldid) {
    const response = await fetch(`/api/snapshot?world=${encodeURIComponent(worldid)}`);
    const payload = parseJsonPayload(await response.text());
    if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    return { snapshot: payload };
  }

  /** Worlds server.py has polled — drives the world picker. Returns {uuid, name, map_version, player_count, last_polled_at}[]. */
  async getPolledWorlds() {
    const response = await fetch("/api/worlds");
    const payload = parseJsonPayload(await response.text());
    if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    return Array.isArray(payload) ? payload : [];
  }

  async _getLocalJson(path, params) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${path}?${query}`);
    const payload = parseJsonPayload(await response.text());
    if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    return Array.isArray(payload) ? payload : [];
  }

  // Same as _getLocalJson() but for a route whose response is an object, not an array.
  async _getLocalJsonObject(path, params) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${path}?${query}`);
    const payload = parseJsonPayload(await response.text());
    if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    return payload && typeof payload === "object" ? payload : {};
  }

  /**
   * Grouped world_events — one entry per (poll batch, event_type, old_uid, new_uid), e.g.
   * "Player A took 5 outposts from Player B" instead of 5 rows.
   * @returns {{groups: object[], nextBeforeId: number|null}}
   */
  /** worldId omitted or falsy means every polled world at once, not just one. */
  async getEvents(worldId, { type, player, beforeId, limit = 20 } = {}) {
    const params = { limit: String(limit) };
    if (worldId) params.world = worldId;
    if (type) params.type = type;
    if (player) params.player = player;
    if (beforeId != null) params.before_id = String(beforeId);
    const { groups, next_before_id } = await this._getLocalJsonObject("/api/events", params);
    return { groups: groups || [], nextBeforeId: next_before_id ?? null };
  }

  /** Every active player's outpost gains/losses (not netted) per day/week/month + current outpost count. Unpaginated. */
  async getActivityLeaderboard(worldId) {
    return this._getLocalJson("/api/leaderboard/activity", { world: worldId });
  }

  /** Every player's current total empire value (home + outposts) + net change per day/week/month. Unpaginated. */
  async getEmpireLeaderboard(worldId) {
    return this._getLocalJson("/api/leaderboard/empire", { world: worldId });
  }

  /** Players whose most recent gain (not any change) predates `days` ago. */
  async getInactivePlayers(worldId, { days = 7 } = {}) {
    return this._getLocalJson("/api/inactive", { world: worldId, days: String(days) });
  }

  /** Exact-match: which polled world(s) `name`'s home base is on right now. */
  async locatePlayer(name) {
    return this._getLocalJson("/api/locate", { name });
  }

  /** As-you-type suggestions — substring match across every world. */
  async suggestPlayers(term, { limit = 8 } = {}) {
    return this._getLocalJson("/api/locate/suggest", { term, limit: String(limit) });
  }

  buildApiUrl(path, query = null) {
    return buildBymUrl(`/api/${this.config.apiVersion}${path}`, query, this.config);
  }

  extractApiVersion(message) {
    const match = String(message || "").match(/Expected(?:\s+one\s+of)?:\s*([^,\s]+)/i);
    return match ? normalizeApiVersion(match[1]) : null;
  }
}
