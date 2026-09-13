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

  // Neither /player/getinfo nor /bm/getnewmap expose the player's worldid, so
  // this is the only client-callable source of it: the same /base/load call
  // (type=build, baseid=DEFAULT) the real game client makes on first login.
  // It also runs the game's own one-time login side effects (Town Hall reward
  // grants, invasion wave rollover) — see ViewerApp._resolveWorldId() for why
  // that's expected. Returns the player's full filtered save, worldid included.
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

  // On-demand single-cell detail: resources, monsters, truce, and live
  // lock/online/under-attack state — the per-viewer fields the bulk endpoints
  // below deliberately leave out. Used for click-to-enrich detail, not bulk
  // loading. Rate-limited server-side at 120 req/min/user.
  // Returns { error, x, y, data: { [x]: { [y]: cellData } } }
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

  // Bulk terrain height map — 640 000 bytes, one per cell, index x*800+y.
  // Deterministic and immutable for the life of a world, so pass back the
  // last ETag to revalidate instead of re-fetching the body.
  // Returns { notModified: true } on a 304, else { bytes, etag }.
  async getTerrain(token, worldid, etag = null) {
    return this._getBulk("/worldmapv2/terrain", token, worldid, etag, "arrayBuffer");
  }

  // Bulk occupancy snapshot — every main yard, outpost, and attacked wild
  // camp, plus their owners. Rebuilt server-side at most once every 5
  // minutes, so revalidate on the same cadence rather than polling harder.
  // Returns { notModified: true } on a 304, else { snapshot, etag }.
  async getSnapshot(token, worldid, etag = null) {
    return this._getBulk("/worldmapv2/snapshot", token, worldid, etag, "json");
  }

  async _getBulk(path, token, worldid, etag, as) {
    const headers = { Authorization: `Bearer ${token}` };
    if (etag) headers["If-None-Match"] = etag;

    const response = await fetch(buildBymUrl(path, { worldid }, this.config), { method: "GET", headers });

    if (response.status === 304) return { notModified: true };

    if (as === "arrayBuffer") {
      if (!response.ok) {
        const payload = parseJsonPayload(await response.text());
        throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
      }
      const buffer = await response.arrayBuffer();
      return { bytes: new Uint8Array(buffer), etag: response.headers.get("ETag") };
    }

    const payload = parseJsonPayload(await response.text());
    if (!response.ok) throw new Error(extractErrorMessage(payload) || response.statusText || "Request failed");
    return { snapshot: payload, etag: response.headers.get("ETag") };
  }

  async getWorlds() {
    return fetchJson(this.buildApiUrl("/worlds"));
  }

  async getLeaderboard(worldId) {
    return fetchJson(this.buildApiUrl("/leaderboards", { worldid: worldId, mapversion: 2 }));
  }

  buildApiUrl(path, query = null) {
    return buildBymUrl(`/api/${this.config.apiVersion}${path}`, query, this.config);
  }

  extractApiVersion(message) {
    const match = String(message || "").match(/Expected(?:\s+one\s+of)?:\s*([^,\s]+)/i);
    return match ? normalizeApiVersion(match[1]) : null;
  }
}
