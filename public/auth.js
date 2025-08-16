// auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

let aktuelBruger = null;

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

  // Sørg for badge findes (du gør det allerede)
  let badgeEl = document.getElementById("notifikations-badge");
  if (!badgeEl) {
    const profilLink = document.querySelector("#profil-link");
    if (profilLink) {
      badgeEl = document.createElement("span");
      badgeEl.id = "notifikations-badge";
      profilLink.appendChild(badgeEl);

      // 🔔 indsæt også klokke hvis den ikke findes
      if (!document.getElementById("bell")) {
        const bell = document.createElement("span");
        bell.id = "bell";
        bell.textContent = "🔔";
        profilLink.insertBefore(bell, badgeEl);
      }
    } else {
      return setTimeout(opdaterNotifikationsBadge, 200);
    }
  }

  // Toggle badge-tekst/visning
  if (error || !count || count === 0) {
    badgeEl.classList.add("skjult");
    badgeEl.textContent = "";
  } else {
    badgeEl.textContent = count;
    badgeEl.classList.remove("skjult");
  }

  // 🔔 Toggle animation på klokken
  const bell = document.getElementById("bell");
  if (bell) {
    // Fjern for at kunne re‑trigge animationen:
    bell.classList.remove("ring");
    // Force reflow (så anim spiller igen selvom klassen var sat før)
    void bell.offsetWidth;
    if (!error && count > 0) {
      bell.classList.add("ring");
    }
  }

  // (valgfrit) Synkroniser sekundær badge
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
export function hentPublicUrlMedCache(filnavn, bucket = "ruter") {
  const nøgle = `publicUrl_${bucket}_${filnavn}`;
  const cache = localStorage.getItem(nøgle);

  if (cache) {
    const gemt = JSON.parse(cache);
    const nu = Date.now();
    const udløb = gemt?.udløber || 0;

    // ✅ Brug cached version hvis stadig gyldig
    if (nu < udløb && gemt.url) {
      return gemt.url;
    }
  }

  // 🔗 Hent ny public URL (ændrer sig ikke, men vi cache alligevel)
  const { data } = client.storage.from(bucket).getPublicUrl(filnavn);
  const url = data?.publicUrl;

  if (!url) {
    console.warn("❌ Kunne ikke hente public URL for:", filnavn);
    return null;
  }

  // 📦 Gem i cache i 7 dage (kan justeres)
  const udløber = Date.now() + 7 * 24 * 60 * 60 * 1000;
  localStorage.setItem(nøgle, JSON.stringify({
    url,
    udløber
  }));

  return url;
}


// 🟦 Menu-indsætning – med klikbar brugernavn
export async function indsætMenu(bruger) {
  aktuelBruger = bruger;
  const antalNotifikationer = await hentAntalNotifikationer(bruger.id);
  const roller = Array.isArray(bruger.roller) ? bruger.roller
            : Array.isArray(bruger.rolle)  ? bruger.rolle
            : (bruger.rolle ? [bruger.rolle] : []);
			
  // ✅ Nem at udvide: tilføj flere underpunkter her
  const aktiviteterLinks = [
    { label: "Leaderboard", href: "leaderboard.html", id: "menu-leaderboard" },
//    { label: "Slå Klubben", href: "slaa-klubben.html", id: "menu-slaa-klubben" },
//    { label: "Træningsøvelser", href: "traeningsoevelser.html", id: "menu-traeningsoevelser" },
  ];

  const aktiviteterMarkup = `
    <li class="has-submenu">
      <button id="aktiviteter-toggle" class="submenu-toggle" aria-haspopup="true" aria-expanded="false">
		<span class="icon">🏋️</span>
		<span>Aktiviteter</span>
		<span class="chevron" aria-hidden="true">▾</span>
	  </button>

      <ul class="submenu" id="aktiviteter-submenu" role="menu">
  ${aktiviteterLinks.map(l =>
    `<li role="none">
       <a role="menuitem" id="${l.id}" href="${l.href}">
         ${l.label}
       </a>
     </li>`
  ).join("")}
</ul>
    </li>
  `;

  const navMarkup = `
<nav id="menu">
  <div class="menu-header">
    <button id="menu-toggle" aria-expanded="false" aria-controls="menu-links">☰</button>
    <div id="user-name">
      <a href="#" title="Vis profilmenu" id="profil-link">
        <span class="badge-wrapper">
          <span id="notifikations-badge" class="${antalNotifikationer > 0 ? "" : "skjult"}">${antalNotifikationer || ""}</span>
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
	<li><a href="instructor.html">👨🏻‍🎓 Instruktør</a></li>

    ${aktiviteterMarkup}

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

if (!window.__hideOnScrollInitDone) {
  initHideOnScrollMenu();
  window.__hideOnScrollInitDone = true;
}

// Hent leaderboard_deltagelse fra brugeren
const { data: profilData, error: profilError } = await client
  .from("users")
  .select("leaderboard_deltagelse")
  .eq("id", bruger.id)
  .single();

if (profilError) {
  console.error("Kunne ikke hente leaderboard_deltagelse:", profilError);
}

const profilMarkup = `
<div id="profil-panel" class="profil-skjult">
  <div class="profil-indhold">
    <h2 id="profil-navn">👤 ${bruger.navn}</h2>
    <li><a href="beskeder.html" id="besked-link-profil">💬 Mine beskeder
      <span id="badge-profil" class="badge ${antalNotifikationer > 0 ? "" : "skjult"}">${antalNotifikationer || ""}</span>
    </a></li>
    <li><a href="minelog.html">📘 Mine logs</a></li>
	<li><a href="beviser.html">📜 Mine beviser</a></li>
    <li>
      <label>
        <input type="checkbox" id="push-toggle"> 🔔Notifikationer
      </label>
    </li>
    <li>
      <label>
        <input type="checkbox" id="leaderboard-toggle" ${profilData?.leaderboard_deltagelse !== false ? "checked" : ""}> 🏆 Leaderboard
      </label>
    </li>
    <p><li><a href="#" id="logout-link">🚪 Log ud</a></li></p>
  </div>
</div>
`;
  document.body.insertAdjacentHTML("beforeend", profilMarkup);

  // Eventlistener for at opdatere feltet i databasen
  const leaderboardToggle = document.getElementById("leaderboard-toggle");
  if (leaderboardToggle) {
    leaderboardToggle.addEventListener("change", async (e) => {
      const deltag = e.target.checked;
      const { error } = await client
        .from("users")
        .update({ leaderboard_deltagelse: deltag })
        .eq("id", bruger.id);

      if (error) {
        console.error("Kunne ikke opdatere leaderboard-status:", error);
      }
    });
  }

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

  // Toggle-effekt for hovedmenu + submenu
setTimeout(() => {
  const menuToggleBtn = document.getElementById("menu-toggle");
  const menuLinks     = document.getElementById("menu-links");
  const menuWrapper   = document.getElementById("menu");

  const aktiviteterToggle  = document.getElementById("aktiviteter-toggle");
  const aktiviteterSubmenu = document.getElementById("aktiviteter-submenu");

  if (!menuToggleBtn || !menuLinks || !menuWrapper) return;

  // Helpers
  const closeSubmenu = () => {
    if (aktiviteterSubmenu) {
      aktiviteterSubmenu.classList.remove("show");
      aktiviteterToggle?.setAttribute("aria-expanded", "false");
    }
  };

const openMainMenu = () => {
  menuLinks.classList.add("show");
  menuWrapper.classList.add("open");
  menuToggleBtn.setAttribute("aria-expanded", "true");

  // Undgå hide mens åben
  menuWrapper.classList.remove('hide-on-scroll');

  // Ignorér scroll fra layout/reflow lige når den åbner
  userScrolling = false;
  scrollCloseArmed = false;
  setTimeout(() => { scrollCloseArmed = true; }, 250); // 250ms buffer
};


  const closeMainMenu = () => {
    menuLinks.classList.remove("show");
    menuWrapper.classList.remove("open");
    menuToggleBtn.setAttribute("aria-expanded", "false");
    closeSubmenu();
  };

  // Hovedmenu toggle
  menuToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // undgå at "klik-udenfor" fyrer samtidig
    const isOpen = menuLinks.classList.contains("show");
    if (isOpen) closeMainMenu(); else openMainMenu();
  });

  // Submenu toggle
  if (aktiviteterToggle && aktiviteterSubmenu) {
    aktiviteterToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = aktiviteterSubmenu.classList.toggle("show");
      aktiviteterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // Klik inde i menuen skal ikke lukke den
	menuWrapper.addEventListener("click", (e) => e.stopPropagation());
	menuWrapper.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Luk ved klik/touch udenfor
  const onOutside = (e) => {
    if (!menuWrapper.contains(e.target)) closeMainMenu();
  };
  document.addEventListener("click", onOutside);
  document.addEventListener("pointerdown", onOutside, { passive: true });

  // Luk når man klikker et link i menuen
  menuLinks.querySelectorAll("a, button[role='menuitem']").forEach((el) => {
    el.addEventListener("click", () => closeMainMenu());
  });

  // Escape lukker
  const onKey = (e) => {
    if (e.key === "Escape") closeMainMenu();
  };
  document.addEventListener("keydown", onKey);

// --- Luk ved scroll KUN når brugeren faktisk scroller (wheel/touch), ikke ved reflow ---
let userScrolling = false;
let scrollCloseArmed = false;

window.addEventListener('wheel', () => { userScrolling = true; }, { passive: true });
window.addEventListener('touchmove', () => { userScrolling = true; }, { passive: true });

// Luk kun hvis menu er åben, brugeren scroller, og vi er forbi åbnings-bufferen
window.addEventListener('scroll', () => {
  if (menuWrapper.classList.contains('open') && userScrolling && scrollCloseArmed) {
    closeMainMenu();
  }
}, { passive: true });


  // (Valgfrit) Luk hvis vi resizer til desktop
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 900) closeMainMenu();
  });
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
  panel.classList.remove("profil-skjult");
  panel.classList.add("vis");
};

window.lukProfilMenu = function () {
  const panel = document.getElementById("profil-panel");
  panel.classList.remove("vis");
  panel.classList.add("profil-skjult");
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

function initHideOnScrollMenu() {
  const menu = document.getElementById('menu');
  if (!menu) return;

  let lastY = window.scrollY || 0;
  let ticking = false;

  // Justér følsomhed – start uden dødzone for at teste
  let DELTA = 6;      // sæt evt. tilbage til 6 når du ser det virker
  const MIN_TOP = 10; // først skjul når man ikke er helt i top

  const apply = () => {	
    const y = window.scrollY || 0;
    if (Math.abs(y - lastY) < DELTA) { ticking = false; return; }

 if (menu.classList.contains('open')) {
   menu.classList.remove('hide-on-scroll'); 
   lastY = y;
   ticking = false;
   return;
 }

    if (y > lastY && y > MIN_TOP) {
      menu.classList.add('hide-on-scroll');
    } else {
      menu.classList.remove('hide-on-scroll');
    }

    lastY = y;
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(apply);
      ticking = true;
    }
  }, { passive: true });

  // Bonus: vis menu igen ved interaktion
  ['keydown','focus'].forEach(evt =>
    window.addEventListener(evt, () => menu.classList.remove('hide-on-scroll'), { passive: true })
  );
}





