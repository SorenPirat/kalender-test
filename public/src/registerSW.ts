export function registerSW() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(reg => {
        // Lyt efter opdateringer
        if (reg.waiting) promptToReload(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener("statechange", () => {
            if (newSW.state === "installed" && navigator.serviceWorker.controller) {
              // Ny version klar – tilbyd genindlæsning
              promptToReload(newSW);
            }
          });
        });
      })
      .catch(err => console.error("SW registration failed", err));
  });
}

function promptToReload(sw: ServiceWorker) {
  // Simpelt flow: genindlæs uden prompt. Udskift evt. med in-app snackbar.
  sw.postMessage({ type: "SKIP_WAITING" });
  sw.addEventListener("statechange", () => {
    if (sw.state === "activated") {
      window.location.reload();
    }
  });
}