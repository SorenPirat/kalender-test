// auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const client = createClient(
  "https://cianxaxaphvrutmstydr.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpYW54YXhhcGh2cnV0bXN0eWRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk4MTk2NTAsImV4cCI6MjA2NTM5NTY1MH0.gdBTs6VoPx3BUAPW63o7kh3WbaCrjfe5YIRe3ubV_mQ"
);

// 🟢 Funktion til adgangskontrol
export async function adgangskontrol({ tilladteRoller = [], redirectVedFejl = "index.html", efterLogin = () => {} }) {
  const { data: { user }, error } = await client.auth.getUser();

  if (!user || error) {
    window.location.href = redirectVedFejl;
    return;
  }

  let bruger = localStorage.getItem("bruger");

  if (bruger) {
bruger = JSON.parse(bruger);

// Backwards compatibility: hvis kun bruger.rolle findes, lav bruger.roller
if (!bruger.roller && bruger.rolle) {
  bruger.roller = [bruger.rolle];
}

// Sikrer at roller ikke er nested (fx [["admin"]])
if (Array.isArray(bruger.roller) && Array.isArray(bruger.roller[0])) {
  bruger.roller = bruger.roller.flat();
}

	
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
  roller: profile.rolle
};


    localStorage.setItem("bruger", JSON.stringify(bruger));
  }

  if (
  tilladteRoller.length > 0 &&
  !tilladteRoller.some((rolle) => bruger.roller?.includes(rolle))
) {
    alert("❌ Du har ikke adgang til denne side.");
    window.location.href = redirectVedFejl;
    return;
  }

  // Hvis der allerede findes et #user-name i DOM'en, skriv til det (fallback)
  const nameBox = document.getElementById("user-name");
if (nameBox) {
  nameBox.textContent = `👤 ${bruger.navn} (${bruger.roller.join(", ")})`;
}

efterLogin(bruger); 
}

// 🟦 Menu-indsætning – med klikbar brugernavn
export function indsætMenu(bruger) {
  const navMarkup = `
  <nav id="menu">
    <div class="menu-header">
      <button id="menu-toggle">☰</button>
<div id="user-name">
  <span>${bruger.navn} (${bruger.roller.join(", ")})</span>
</div>
    </div>
    <ul id="menu-links">
      <li><a href="protected.html">🏠 Hjem</a></li>
      <li><a href="public.html">📅 Kalender</a></li>
      <li><a href="kontakt.html">📞 Kontakt</a></li>
${bruger.roller.includes("admin") || bruger.roller.includes("nøglebærer") || bruger.roller.includes("eventmaker")
  ? '<li><a href="noeglevagter.html">🔑 Nøglevagter</a></li>'
  : ''}

${bruger.roller.includes("admin")
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

      document.addEventListener("click", (e) => {
        if (!menuWrapper.contains(e.target) && menuLinks.classList.contains("show")) {
          menuLinks.classList.remove("show");
          menuWrapper.classList.remove("open");
        }
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menuLinks.classList.contains("show")) {
          menuLinks.classList.remove("show");
          menuWrapper.classList.remove("open");
        }
      });
    }
  }, 0);

  // Logout
  setTimeout(() => {
    const logoutBtn = document.getElementById("logout-link");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        localStorage.removeItem("bruger");
        const { error } = await client.auth.signOut();
        if (!error) {
          window.location.href = "index.html";
        }
      });
    }
  }, 0);
}


