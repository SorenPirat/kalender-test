// auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const client = createClient(
  "https://cianxaxaphvrutmstydr.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpYW54YXhhcGh2cnV0bXN0eWRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk4MTk2NTAsImV4cCI6MjA2NTM5NTY1MH0.gdBTs6VoPx3BUAPW63o7kh3WbaCrjfe5YIRe3ubV_mQ"
);

// 🟢 Funktion til adgangskontrol
export async function adgangskontrol({ tilladteRoller = [], redirectVedFejl = "login.html", efterLogin = () => {} }) {
  const { data: { user }, error } = await client.auth.getUser();

  if (!user || error) {
    window.location.href = redirectVedFejl;
    return;
  }

  let bruger = localStorage.getItem("bruger");

  if (bruger) {
    bruger = JSON.parse(bruger);
  } else {
    const { data: profile, error: profileError } = await client
      .from("users")
      .select("navn, rolle")
      .eq("id", user.id)
      .single();

    if (!profile || profileError) {
      window.location.href = redirectVedFejl;
      return;
    }

    bruger = {
      id: user.id,
      navn: profile.navn,
      rolle: profile.rolle
    };
    localStorage.setItem("bruger", JSON.stringify(bruger));
  }

  if (tilladteRoller.length > 0 && !tilladteRoller.includes(bruger.rolle)) {
    alert("❌ Du har ikke adgang til denne side.");
    window.location.href = redirectVedFejl;
    return;
  }

  // Hvis der allerede findes et #user-name i DOM'en, skriv til det (fallback)
  const nameBox = document.getElementById("user-name");
  if (nameBox) {
    nameBox.textContent = `👤 ${bruger.navn} (${bruger.rolle})`;
  }

  efterLogin(bruger);
}

// 🟦 Menu-indsætning – export separat
export function indsætMenu(bruger) {
  const navMarkup = `
  <nav id="menu">
    <div class="menu-header">
      <button id="menu-toggle">☰</button>
      <div id="user-name">👤 ${bruger.navn} (${bruger.rolle})</div>
    </div>
    <ul id="menu-links">
      <li><a href="protected.html">🏠 Hjem</a></li>
      <li><a href="public.html">📅 Kalender</a></li>
      <li><a href="kontakt.html">📞 Kontakt</a></li>
     ${bruger.rolle === "admin" || bruger.rolle === "nøglebærer"
  ? '<li><a href="noeglevagter.html">🔑 Nøglevagter</a></li>'
  : ''}

${bruger.rolle === "admin"
  ? '<li><a href="adminpanel.html">🛠️ Adminpanel</a></li>'
  : ''}

      <li><a href="#" id="logout-link">🚪 Log ud</a></li>
    </ul>
  </nav>
  `;

  document.body.insertAdjacentHTML("afterbegin", navMarkup);

  // Toggle-effekt
  setTimeout(() => {
    const menuToggleBtn = document.getElementById("menu-toggle");
    const menuLinks = document.getElementById("menu-links");
    const menuWrapper = document.getElementById("menu");

if (menuToggleBtn && menuLinks && menuWrapper) {
      menuToggleBtn.addEventListener("click", () => {
        menuLinks.classList.toggle("show");
        menuWrapper.classList.toggle("open");
      });

      // 💡 Klik udenfor lukker menu
      document.addEventListener("click", (e) => {
        if (!menuWrapper.contains(e.target) && menuLinks.classList.contains("show")) {
          menuLinks.classList.remove("show");
          menuWrapper.classList.remove("open");
        }
      });

      // 💡 Escape-tast lukker menu
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menuLinks.classList.contains("show")) {
          menuLinks.classList.remove("show");
          menuWrapper.classList.remove("open");
        }
      });
    }
  }, 0);
  
  // Log ud
  setTimeout(() => {
    const logoutBtn = document.getElementById("logout-link");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        localStorage.removeItem("bruger");
        const { error } = await client.auth.signOut();
        if (!error) {
          window.location.href = "login.html";
        }
      });
    }
  }, 0);
}
