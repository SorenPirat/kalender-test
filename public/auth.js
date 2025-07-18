// auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const client = createClient(
  "https://cianxaxaphvrutmstydr.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpYW54YXhhcGh2cnV0bXN0eWRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk4MTk2NTAsImV4cCI6MjA2NTM5NTY1MH0.gdBTs6VoPx3BUAPW63o7kh3WbaCrjfe5YIRe3ubV_mQ"
);

// hentAntalNotifikationer
export async function hentAntalNotifikationer(brugerId) {
  const { count, error } = await client
    .from("kontakt_notifications")
    .select("*", { count: "exact", head: true })
    .eq("bruger_id", brugerId);

  if (error) {
    console.error("❌ Fejl ved hentning af notifikationer:", error);
    return 0;
  }

  return count || 0;
}

export async function opdaterNotifikationsBadge() {
  const bruger = JSON.parse(localStorage.getItem("bruger"));
  if (!bruger) return;

  const { count, error } = await client
    .from("kontakt_notifications")
    .select("*", { count: "exact", head: true })
    .eq("bruger_id", bruger.id);

  let badgeEl = document.getElementById("notifikations-badge");

  if (!badgeEl) {
    const profilLink = document.querySelector("#profil-link");
    if (profilLink) {
      badgeEl = document.createElement("span");
      badgeEl.id = "notifikations-badge";
      profilLink.appendChild(badgeEl);
    } else {
      // prøv igen lidt senere hvis linket ikke er klar endnu
      return setTimeout(opdaterNotifikationsBadge, 200);
    }
  }

if (error || !count || count === 0) {
  badgeEl.classList.add("skjult");
  badgeEl.textContent = "";
} else {
  badgeEl.textContent = count;
  badgeEl.classList.remove("skjult");
}
}



// 🟢 Funktion til adgangskontrol
export async function adgangskontrol({ tilladteRoller = [], redirectVedFejl = "index.html", efterLogin = () => {} }) {
  const { data: { user }, error } = await client.auth.getUser();

  if (!user || error) {
    window.location.href = redirectVedFejl;
    return;
  }

  // 🎯 Altid hent opdateret brugerprofil fra Supabase
  const { data: profile, error: profileError } = await client
    .from("users")
    .select("navn, rolle")
    .eq("id", user.id)
    .single();

  if (!profile || profileError) {
    window.location.href = redirectVedFejl;
    return;
  }

  const bruger = {
    id: user.id,
    navn: profile.navn,
    roller: Array.isArray(profile.rolle) ? profile.rolle : [profile.rolle || "klubmedlem"]
  };

  // 🔁 Opdater localStorage med nyeste data
  localStorage.setItem("bruger", JSON.stringify(bruger));

  // 🔒 Tjek roller
  if (
    tilladteRoller.length > 0 &&
    !tilladteRoller.some((rolle) => bruger.roller?.includes(rolle))
  ) {
    document.body.innerHTML = `
  <h2>🚫 Adgang nægtet</h2>
  <p>Bruger: ${bruger.navn}</p>
  <p>Dine roller: ${bruger.roller.join(", ")}</p>
  <p>Krævede roller: ${tilladteRoller.join(", ")}</p>
  <p><a href="index.html">↩️ Gå tilbage</a></p>
`;
return;

  }

  // 🖊️ Opdater fallback visning i DOM'en
  const nameBox = document.getElementById("user-name");
  if (nameBox) {
    nameBox.textContent = `👤 ${bruger.navn} (${bruger.roller.join(", ")})`;
  }

  efterLogin(bruger);
}


// 🟦 Menu-indsætning – med klikbar brugernavn
export async function indsætMenu(bruger) {
  const antalNotifikationer = await hentAntalNotifikationer(bruger.id);

  const navMarkup = `
<nav id="menu">
  <div class="menu-header">
    <button id="menu-toggle">☰</button>
    <div id="user-name">
      <a href="auth.html" title="Gå til din profil" id="profil-link">
        <span class="badge-wrapper">
          <span id="notifikations-badge" class="skjult"></span>
          <span class="profiltekst">
            <div class="navn-linje">👤 ${bruger.navn}</div>
            <div class="rolle-linje">(${bruger.roller.join(", ")})</div>
          </span>
        </span>
      </a>
    </div>
  </div>
  <ul id="menu-links">
    <li><a href="protected.html">🏠 Hjem</a></li>
    <li><a href="public.html">📅 Kalender</a></li>
    <li><a href="kontakt.html">📞 Kontakt</a></li>
    ${bruger.roller.includes("bestyrelsesmedlem") || bruger.roller.includes("admin")
      ? '<li><a href="bestyrelse.html">📁 Bestyrelse</a></li>' : ''}
    ${bruger.roller.includes("admin") || bruger.roller.includes("nøglebærer") || bruger.roller.includes("eventmaker")
      ? '<li><a href="noeglevagter.html">🔑 Nøglevagter</a></li>' : ''}
    ${bruger.roller.includes("admin")
      ? '<li><a href="adminpanel.html">🛠️ Adminpanel</a></li>' : ''}
    <li><a href="#" id="logout-link">🚪 Log ud</a></li>
  </ul>
</nav>
`;

  document.body.insertAdjacentHTML("afterbegin", navMarkup);

  // Real-time badge-lytning
  setTimeout(() => {
    lytTilNotifikationer(bruger.id);
    opdaterNotifikationsBadge();
  }, 300);

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



export function lytTilNotifikationer(brugerId) {
  client.channel('notifikations-lyt')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'kontakt_notifications' },
      payload => {
        const notifikation = payload.new || payload.old;
        if (notifikation?.bruger_id === brugerId) {
          opdaterNotifikationsBadge();
        }
      }
    )
    .subscribe();
}






