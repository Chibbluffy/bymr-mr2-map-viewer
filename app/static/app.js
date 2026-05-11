import { ViewerApp } from "./js/viewer-app.js";

window.addEventListener("DOMContentLoaded", () => {
  const app = new ViewerApp();
  app.start().catch((error) => {
    console.error(error);
    const status = document.getElementById("session-status");
    if (status) status.textContent = error.message || "Viewer failed to start.";
  });
});
