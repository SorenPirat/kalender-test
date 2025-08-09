// gate.js
(function () {
  // Tillad opt-out ved at tilføje data-no-auth-gate på <html> eller <body>
  const html = document.documentElement;
  const body = document.body;

  // Udelad index/login sider
  const path = (location.pathname || "").toLowerCase();
  const isIndex =
    path.endsWith("/") ||
    path.endsWith("/index.html") ||
    path === "" ||
    path === "/";

  // Opt-out?
  const noGate =
    (html && html.hasAttribute("data-no-auth-gate")) ||
    (body && body.hasAttribute("data-no-auth-gate"));

  if (isIndex || noGate) {
    html.classList.remove("auth-wait");
    return;
  }

  // Skjul siden ASAP
  html.classList.add("auth-wait");

  // Injicer minimal CSS (hurtigere end at vente på base.css)
  const style = document.createElement("style");
  style.setAttribute("data-auth-gate-style", "");
  style.textContent = `
    .auth-wait body { visibility: hidden; }
  `;
  document.head.prepend(style);

  // Global hook: kald denne fra adgangskontrol(efterLogin)
  window.releaseAuthGate = function releaseAuthGate() {
    html.classList.remove("auth-wait");
    const s = document.querySelector("style[data-auth-gate-style]");
    if (s) s.remove();
  };

  // Fail-safe: hvis vi ikke er frigivet inden 5s, antag uautoriseret og send til login
  window.setTimeout(() => {
    if (html.classList.contains("auth-wait")) {
      location.href = "index.html";
    }
  }, 5000);
})();
