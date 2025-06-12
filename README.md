# 🧗 Klatreklub Kalender & PWA

Dette projekt er en digital kalender- og kommunikationsplatform til brug i vores klatreklub. Systemet fungerer både som offentlig hjemmeside og som installérbar app (PWA) for medlemmer, bestyrelsen og frivillige teams. Målet er at erstatte brugen af Facebook for klubkommunikation og sikre tilgængelighed for alle medlemmer.

---

## 🔧 Teknisk opsætning

**Frontend**  
- HTML, CSS, JavaScript  
- Hostet på Netlify  
- PWA: Manifest + service worker

**Backend**  
- Node.js + Express  
- Hostet på Render

**Data og Integrationer**  
- Google Sheets til intern datahåndtering  
- Google Calendar API til eksterne events  
- Web Push API til notifikationer

---

## 🚀 Deployment

### Frontend (Netlify)
1. Push til `https://github.com/SorenPirat/kalender-test/`-branch på GitHub
2. Netlify bygger automatisk fra `public/` mappen

### Backend (Render)
1. Render trækker fra `backend/` mappen
2. Miljøvariabler konfigureres i Render dashboardet

### Google Sheets Setup
- Sheet ID: `1VATNNBNEeeS0uSGAGgLxQBPD1wR6Cer1XPo1vEwinfI`
- Kræver Google Service Account
- Del sheet med service accountens e-mailadresse

---

## 🧪 Testkalender

Testversion bruges til at afprøve nye funktioner:

- Test-frontend: `https://nglevagter-test.netlify.app/`
- Test-backend: `https://nglevagter-test.onrender.com`
- Test-Sheet: `https://docs.google.com/spreadsheets/d/1VATNNBNEeeS0uSGAGgLxQBPD1wR6Cer1XPo1vEwinfI`

---

## 🔑 API-nøgler & adgang

> Bemærk: Nøgler må **aldrig** pushes til GitHub.

| Tjeneste        | Miljøvariabel            |
|----------------|---------------------------|
| Google Sheets  | `GOOGLE_SERVICE_KEY`      |
| Google Calendar| `GOOGLE_CALENDAR_ID`      |
| Render backend | `.env` på Render          |

Alle adgangsoplysninger gemmes i delt dokument eller password vault.

---

## 👥 Brugertyper

| Rolle         | Funktioner |
|---------------|------------|
| **Medlemmer** | Se kalender, tilmeld begivenheder, modtag notifikationer |
| **Bestyrelse**| Opret/luk dage, vedligehold data og kommunikation |
| **Frivillige**| Se teamkalender, opgaver, beskeder |

---

## 📚 Dokumentation

- [Google Doc: Sådan bruger du systemet](#)
- [Overdragelsesguide til ny bestyrelse](#)
- [Sheets og systemoverblik](#)

---

## 🧑‍💻 Vedligeholdelse og overdragelse

Hvis projektet skal overdrages til ny bestyrelse:

- Læs dokumentation i Google Docs
- Sørg for, at GitHub-repo og konti er delt med fælles klubmail
- Udpeg en teknisk ansvarlig (frivillig eller bestyrelsesmedlem)

---

## 🌱 Fremtidsidéer

- Bookingmodul til nøgler og faciliteter
- Login med Google
- Statistik og aktivitetsgraf
- Dashboard til bestyrelsen
- Mere avanceret teamstyring
- Automatisk udsendelse af nyhedsbrev
