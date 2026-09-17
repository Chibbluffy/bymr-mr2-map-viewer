import { ViewerApp } from "./js/viewer-app.js";

// Single bootstrap for both the normal viewer and /tnb/export/ — server.py's
// translate_path() serves this same file/index.html for both URLs.
const isExportPage = location.pathname.startsWith("/tnb/export");

window.addEventListener("DOMContentLoaded", async () => {
  if (isExportPage) applyExportPageChrome();

  const app = new ViewerApp();
  app.start().catch((error) => {
    console.error(error);
    const status = document.getElementById("session-status");
    if (status) status.textContent = error.message || "Viewer failed to start.";
  });

  if (isExportPage) {
    const { wireExport } = await import("./tnb/export/export.js");
    wireExport(app);
  }
});

function applyExportPageChrome() {
  document.title = "BYM MR2 Viewer — Export";

  const robotsMeta = document.createElement("meta");
  robotsMeta.name = "robots";
  robotsMeta.content = "noindex, nofollow";
  document.head.appendChild(robotsMeta);

  const brand = document.querySelector(".top-bar-brand");
  if (brand) brand.append(" — Export");

  const status = document.getElementById("session-status");
  if (status) {
    status.textContent = "Log in to export live resource data (optional). Your credentials go straight to the game server, never to this app's own server.";
  }

  const exportGroup = document.getElementById("export-button-group");
  if (exportGroup) exportGroup.hidden = false;
}
