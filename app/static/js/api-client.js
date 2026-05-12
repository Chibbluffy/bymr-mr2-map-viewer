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

  // Current loader — 10x10 chunk via /worldmapv2/getarea.
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

  // Future bulk loader — up to 20 000 1-based cell IDs per call.
  // Swap _startFullMapLoad to use this once /worldmapv2/getcellsforviewer is deployed.
  // Returns { celldata: [{ x, y, ...fields }] }
  async getMapCells(token, cellIds) {
    return fetchJson(buildBymUrl("/worldmapv2/getcellsforviewer", null, this.config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({ cellids: JSON.stringify(cellIds) }),
    });
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
