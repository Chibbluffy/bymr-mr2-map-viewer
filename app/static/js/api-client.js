import {
  extractErrorMessage,
  getViewerConfig,
  parseJsonPayload,
} from "./shared.js";

// No player login — this app reads only server.py's own SQLite-backed API,
// which is itself kept in sync by poller.py using a server-side API key.
// Nothing here ever talks to the live BYM game server directly.
export class ApiClient {
  constructor(config = getViewerConfig()) {
    this.config = config;
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
}
