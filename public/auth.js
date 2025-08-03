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

const badgeProfil = document.getElementById("badge-profil");
if (badgeProfil) {
  if (error || !count || count === 0) {
    badgeProfil.classList.add("skjult");
    badgeProfil.textContent = "";
  } else {
    badgeProfil.textContent = count;
    badgeProfil.classList.remove("skjult");
  }
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

// Cacher rutebilleder i 7 dage til localstorage
export async function hentSignedUrl(filnavn, bucket = "ruter") {
  const nøgle = `signedUrl_${bucket}_${filnavn}`;
  const cache = localStorage.getItem(nøgle);

  if (cache) {
    const gemt = JSON.parse(cache);
    const nu = Date.now();
    const udløb = gemt?.udløber || 0;

    // Test om link stadig er gyldigt (ikke udløbet)
    if (nu < udløb && gemt.url) {
      // Valider evt. linket ved at lave en HEAD-request
      try {
        const test = await fetch(gemt.url, { method: "HEAD" });
        if (test.ok) {
          return gemt.url; // stadig gyldigt
        } else {
          console.warn("🔁 Cached signed URL ikke længere gyldig – henter ny.");
        }
      } catch (err) {
        console.warn("❌ Fejl ved HEAD-request til cached URL:", err);
      }
    }
  }

  // 🔁 Hent ny signed URL fra Supabase (7 dage)
  const { data, error } = await client
    .storage
    .from(bucket)
    .createSignedUrl(filnavn, 60 * 60 * 24 * 7);

  if (error || !data?.signedUrl) {
    console.warn("❌ Kunne ikke hente ny signed URL:", error);
    return null;
  }

  // Gem ny URL i cache
  const udløber = Date.now() + 7 * 24 * 60 * 60 * 1000;
  localStorage.setItem(nøgle, JSON.stringify({
    url: data.signedUrl,
    udløber
  }));

  return data.signedUrl;
}


// 🟦 Menu-indsætning – med klikbar brugernavn
export async function indsætMenu(bruger) {
  const antalNotifikationer = await hentAntalNotifikationer(bruger.id);

  const navMarkup = `
<nav id="menu">
  <div class="menu-header">
    <button id="menu-toggle">☰</button>
    <div id="user-name">
      <a href="#" title="Vis profilmenu" id="profil-link">
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
	<li><a href="ruteoversigt.html">🧗 Ruteoversigt</a></li>
    ${bruger.roller.includes("bestyrelsesmedlem") || bruger.roller.includes("admin")
      ? '<li><a href="bestyrelse.html">📁 Bestyrelse</a></li>' : ''}
    ${bruger.roller.includes("admin") || bruger.roller.includes("nøglebærer") || bruger.roller.includes("eventmaker")
      ? '<li><a href="noeglevagter.html">🔑 Nøglevagter</a></li>' : ''}
    ${bruger.roller.includes("admin")
      ? '<li><a href="adminpanel.html">🛠️ Adminpanel</a></li>' : ''}
	${bruger.roller.includes("rutebygger") || bruger.roller.includes("admin")
      ? '<li><a href="testruteupload.html">👷 Rutebygger</a></li>' : ''}  
  </ul>
</nav>
`;

  document.body.insertAdjacentHTML("afterbegin", navMarkup);

const profilMarkup = `
<div id="profil-panel" class="profil-skjult">
  <div class="profil-indhold">
    <h2 id="profil-navn">👤 ${bruger.navn}</h2>
    <li><a href="beskeder.html" id="besked-link-profil">💬 Gå til beskeder 
      <span id="badge-profil" class="badge skjult"></span>
    </a></li>
    <li><a href="minelog.html">📘 Mine logs</a></li>
    <li><label><input type="checkbox" id="push-toggle"> 🔔 Notifikationer</label></li>
    </select></li>
	<p><li><a href="#" id="logout-link">🚪 Log ud</a></li></p>
  </div>

</div>
`;
document.body.insertAdjacentHTML("beforeend", profilMarkup);

const lukKnap = document.getElementById("luk-profil-knap");
if (lukKnap) {
  lukKnap.addEventListener("click", () => {
    lukProfilMenu();
  });
}

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

  // Klik på profil → vis profilmenu
  const profilKnap = document.getElementById("profil-link");
  if (profilKnap) {
    profilKnap.addEventListener("click", (e) => {
      e.preventDefault();
      visProfilMenu();
    });
  }
}

window.visProfilMenu = function () {
  const panel = document.getElementById("profil-panel");
  const bruger = JSON.parse(localStorage.getItem("bruger"));
  document.getElementById("profil-navn").textContent = `👤 ${bruger?.navn || "Ukendt"}`;
  document.getElementById("push-toggle").checked = localStorage.getItem("push") === "true";
  panel.classList.add("vis");
};

window.lukProfilMenu = function () {
  document.getElementById("profil-panel").classList.remove("vis");
};

// Åben/luk profil-vindue
document.addEventListener("click", (e) => {
  const panel = document.getElementById("profil-panel");
  const profilLink = document.getElementById("profil-link");
  if (
    panel.classList.contains("vis") &&
    !panel.contains(e.target) &&
    !profilLink.contains(e.target)
  ) {
    panel.classList.remove("vis");
  }
});

// Luk profilmenu automatisk når man scroller
window.addEventListener("scroll", () => {
  const panel = document.getElementById("profil-panel");
  if (panel && panel.classList.contains("vis")) {
    lukProfilMenu();
  }
});

// Gem brugerens valg
setTimeout(() => {
  document.getElementById("push-toggle")?.addEventListener("change", e => {
    localStorage.setItem("push", e.target.checked);
  });

  document.getElementById("dark-toggle")?.addEventListener("change", e => {
    localStorage.setItem("dark", e.target.checked);
    document.documentElement.classList.toggle("dark-mode", e.target.checked);
  });

  document.getElementById("language-select")?.addEventListener("change", e => {
    localStorage.setItem("language", e.target.value);
    location.reload();
  });
}, 500);


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






