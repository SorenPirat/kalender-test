import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from "uuid";

// ===== Supabase database =====
const supabase = createClient(
  'https://cianxaxaphvrutmstydr.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// ===== Google Auth =====
const calendarAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/calendar']
});

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const calendar = google.calendar({ version: 'v3', auth: calendarAuth });
const spreadsheetId = process.env.SPREADSHEET_ID;
const sheetName = 'Sheet1';

// ===== Utility: Beregn næste dag i ISO-format =====
function getNextDate(dateStr) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
}

// ===== Google Sheets: Hent data =====
async function getSheetData() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:B`,
  });

  const rows = response.data.values || [];
  const result = {};
  for (const [date, value] of rows) {
    result[date] = value;
  }
  return result;
}

// ===== Google Kalender: Hent begivenheder =====
async function getAllCalendarEvents() {
  const calendarId = process.env.CLUB_CALENDAR_ID;

  const timeMin = new Date(2025, 5, 1);
  const timeMax = new Date(2025, 11, 31, 23, 59, 59);
  timeMin.setDate(timeMin.getDate() - 7);
  timeMax.setDate(timeMax.getDate() + 7);

  const response = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return response.data.items || [];
}

// ===== Google Sheets: Opdater celle =====
async function updateSheetEntry(day, name) {
  const current = await getSheetData();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const allDates = Object.keys(current);
  const index = allDates.indexOf(day);
  const row = index >= 0 ? index + 2 : allDates.length + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${row}:B${row}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[day, name]],
    },
  });
}

// ===== Express App Setup =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== Routes =====
app.get('/assignments', async (req, res) => {
  try {
    const data = await getSheetData();
    res.json(data);
  } catch (err) {
    console.error('Fejl ved hentning:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

app.get('/assignments-with-events', async (req, res) => {
  try {
    const assignments = await getSheetData();
    const calendarEvents = await getAllCalendarEvents();

    const result = {};

    function getAllDaysInRange(year, monthStart, monthEnd) {
      const days = [];
      for (let m = monthStart; m <= monthEnd; m++) {
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${year}-${m + 1}-${d}`;
          days.push(key);
        }
      }
      return days;
    }

    const allKeys = getAllDaysInRange(2025, 5, 11);

    for (const key of allKeys) {
      const [year, month, day] = key.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      date.setHours(0, 0, 0, 0);

      const matchingEvents = calendarEvents.filter(event => {
        if (event.start.date && event.end.date) {
          const start = new Date(event.start.date);
          const end = new Date(event.end.date);
          start.setHours(0, 0, 0, 0);
          end.setHours(0, 0, 0, 0);
          return date >= start && date < end;
        } else if (event.start.dateTime) {
          const eventDate = new Date(event.start.dateTime);
          eventDate.setHours(0, 0, 0, 0);
          return eventDate.getTime() === date.getTime();
        }
        return false;
      });

      result[key] = {
        name: assignments[key] || null,
        events: matchingEvents.map(ev => ({
          summary: ev.summary,
          id: ev.id
        }))
      };
    }

    res.json(result);
  } catch (err) {
    console.error('Fejl i assignments-with-events:', err);
    res.status(500).json({ error: 'Fejl ved hentning af data' });
  }
});

app.get("/signups", async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const sheetsClient = google.sheets({ version: "v4", auth: authClient });

    const result = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet2!A:B", // kolonne A: eventId, B: navn
    });

    const rows = result.data.values || [];
    const data = rows.map(([eventId, name]) => ({
      eventId,
      name,
    }));

    res.json(data);
  } catch (err) {
    console.error("Fejl ved hentning af tilmeldinger:", err);
    res.status(500).json({ error: "Serverfejl ved hentning af tilmeldinger" });
  }
});


app.post('/assignments', async (req, res) => {
  const { day, days, name } = req.body;

  if (typeof name !== 'string' || (!Array.isArray(days) && typeof day !== 'string')) {
    return res.status(400).json({ error: 'Ugyldige data' });
  }

  try {
    if (Array.isArray(days)) {
      for (const d of days) {
        await updateSheetEntry(d, name);
      }
    } else {
      await updateSheetEntry(day, name);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Fejl ved opdatering:', err);
    res.status(500).json({ error: 'Kunne ikke opdatere' });
  }
});

app.post('/delete-event', async (req, res) => {
  const { eventId } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId mangler' });
  }

  try {
    const authClient = await calendarAuth.getClient();
    const calendarId = process.env.CLUB_CALENDAR_ID;

    await calendar.events.delete({
      calendarId,
      eventId,
      auth: authClient
    });

    res.status(200).json({ success: true, message: 'Begivenhed slettet' });
  } catch (err) {
    console.error('❌ Fejl ved sletning af begivenhed:', err);
    res.status(500).json({ error: 'Kunne ikke slette begivenhed' });
  }
});

app.post('/add-event', async (req, res) => {
  const { title, startDate, endDate, description } = req.body;

  if (!title || !startDate || !endDate) {
    return res.status(400).json({ error: 'Manglende påkrævede felter' });
  }

  try {
    const authClient = await calendarAuth.getClient();

    const event = {
      summary: title,
      description: description || '',
      start: { date: startDate },
      end: { date: getNextDate(endDate) }, // Husk at Google Calendar ikke inkluderer slutdatoen
    };

    const calendarId = process.env.CLUB_CALENDAR_ID;

    await calendar.events.insert({
      calendarId,
      resource: event,
      auth: authClient
    });

    res.status(200).json({ success: true, message: 'Begivenhed oprettet' });
  } catch (err) {
    console.error('❌ Fejl ved oprettelse af heldagsbegivenhed:', err);
    res.status(500).json({ error: 'Kunne ikke oprette begivenhed' });
  }
});

app.post('/remove-closed-event', async (req, res) => {
  const { date } = req.body;

  if (!date) return res.status(400).json({ error: 'Dato mangler' });

  try {
    const calendarId = process.env.CLUB_CALENDAR_ID;
    const authClient = await calendarAuth.getClient();

    const timeMin = new Date(date);
    const timeMax = new Date(date);
    timeMax.setDate(timeMax.getDate() + 1);

    const events = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      auth: authClient
    });

    const matching = events.data.items.find(ev =>
      ev.summary?.toLowerCase().startsWith('lukket')
    );

    if (matching) {
      await calendar.events.delete({
        calendarId,
        eventId: matching.id,
        auth: authClient
      });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Fejl ved sletning af lukket-begivenhed:', err);
    res.status(500).json({ error: 'Kunne ikke fjerne begivenhed' });
  }
});

app.post("/signup", async (req, res) => {
  const { eventId, names } = req.body;

  if (!eventId || !names || (typeof names === "string" && names.trim() === "")) {
    return res.status(400).json({ error: "eventId og names påkrævet" });
  }

  const nameList = Array.isArray(names) ? names : [names];

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    const values = nameList.map(name => [eventId, name]);

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet2!A:B",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: values,
      },
    });

    res.json({ success: true, updated: response.data });
  } catch (err) {
    console.error("Fejl i signup:", err);
    res.status(500).json({ error: "Serverfejl under tilmelding" });
  }
});

app.post("/unsign", async (req, res) => {
  const { eventId, names } = req.body;
  if (!eventId || !names) {
    return res.status(400).json({ error: "eventId og names påkrævet" });
  }

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const sheet = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet2!A:B",
  });

  const rows = sheet.data.values || [];

  const inputNames = names
    .split(/\n|,/)
    .map(n => n.trim().toLowerCase())
    .filter(Boolean);

  const signedUp = rows.filter(([id]) => id === eventId);
  const signedUpNames = signedUp.map(([, name]) => name.trim().toLowerCase());

  const notFound = inputNames.filter(n => !signedUpNames.includes(n));

  const updated = rows.filter(([id, name]) => {
    const norm = (name || "").trim().toLowerCase();
    return !(id === eventId && inputNames.includes(norm));
  });

  while (updated.length < rows.length) {
    updated.push(["", ""]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Sheet2!A1:B`,
    valueInputOption: "RAW",
    resource: {
      values: updated,
    },
  });

  const removed = signedUp.length - updated.filter(([id]) => id === eventId).length;

  res.json({ success: true, removed, notFound });
});

app.get("/signups/:eventId", async (req, res) => {
  const { eventId } = req.params;
  if (!eventId) return res.status(400).json({ error: "eventId mangler" });

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet2!A:B",
    });

    const rows = result.data.values || [];
    const names = rows
      .filter(row => row[0] === eventId)
      .map(row => row[1]);

    res.json({ eventId, count: names.length, names });
  } catch (err) {
    console.error("Fejl ved hentning af tilmeldinger:", err);
    res.status(500).json({ error: "Serverfejl under hentning af tilmeldinger" });
  }
});

app.get('/public-events', async (req, res) => {
  try {
    const calendarEvents = await getAllCalendarEvents();

    const publicEvents = calendarEvents.map(ev => ({
      id: ev.id,
      summary: ev.summary,
      description: ev.description || '',
      start: ev.start.date || ev.start.dateTime,
      end: ev.end.date || ev.end.dateTime
    }));

    res.json(publicEvents);
  } catch (err) {
    console.error('Fejl i public-events:', err);
    res.status(500).json({ error: 'Fejl ved hentning af offentlige events' });
  }
});

app.get("/threads", async (req, res) => {
  const brugerId = req.query.brugerId;
  if (!brugerId) {
    return res.status(400).json({ error: "brugerId mangler i forespørgslen" });
  }

  try {
    // 1. Hent brugerens rolle
    const { data: brugerdata, error: brugerFejl } = await supabase
      .from("users")
      .select("rolle")
      .eq("id", brugerId)
      .single();
    if (brugerFejl || !brugerdata) throw brugerFejl || new Error("Bruger ikke fundet");

    const brugerRoller = Array.isArray(brugerdata.rolle)
      ? brugerdata.rolle
      : [brugerdata.rolle];

    // 2. Tråde som afsender
    const { data: oprettedeTråde, error: opretFejl } = await supabase
      .from("threads")
      .select(`
      id,
      titel,
      rolle,
      oprettet_af,
      created_at,
      er_lukket,
      lukket_af,
      opdateret,
      sidst_set_af_afsender,
      sidst_set_af_modtager
      `)
      .eq("oprettet_af", brugerId);
    if (opretFejl) throw opretFejl;

    // 3. Tråde hvor brugerens rolle matcher thread.rolle
    const { data: modtagerTråde, error: rolleFejl } = await supabase
      .from("threads")
      .select(`
      id,
      titel,
      rolle,
      oprettet_af,
      created_at,
      er_lukket,
      lukket_af,
      opdateret,
      sidst_set_af_afsender,
      sidst_set_af_modtager
      `)
      .in("rolle", brugerRoller)
      .neq("oprettet_af", brugerId); // undgå dublet hvis brugeren både er afsender og modtager
    if (rolleFejl) throw rolleFejl;

    const alleTråde = [...oprettedeTråde, ...modtagerTråde];
    const unikkeTråde = Object.values(
      alleTråde.reduce((acc, t) => {
        acc[t.id] = t;
        return acc;
      }, {})
    );

    res.json(unikkeTråde);
  } catch (err) {
    console.error("❌ Fejl i /threads:", err);
    res.status(500).json({ error: "Serverfejl ved hentning af tråde" });
  }
});


// ==== Svar på tråde ====
app.post("/reply", async (req, res) => {
  const { thread_id, afsender, tekst, billede_url, lyd_url } = req.body;

  if (!thread_id || !afsender || (!tekst && !billede_url && !lyd_url)) {
    return res.status(400).json({ error: "Manglende felter" });
  }

  try {
    // 1. Gem beskeden
    const { error: messageError } = await supabase
      .from("messages")
      .insert({
        thread_id,
        afsender,
        tekst,
        billede_url,
        lyd_url
      });
    if (messageError) throw messageError;

    // 2. Opdater opdateret-felt på tråden
    const { error: updateError } = await supabase
      .from("threads")
      .update({ opdateret: new Date().toISOString() })
      .eq("id", thread_id);
    if (updateError) throw updateError;

    // 3. Hent trådinfo inkl. rolle og oprettet_af
    const { data: tråd, error: trådFejl } = await supabase
      .from("threads")
      .select("rolle, oprettet_af")
      .eq("id", thread_id)
      .single();
    if (trådFejl || !tråd) throw trådFejl || new Error("Tråd ikke fundet");

    const målrolle = tråd.rolle;

    // 4. Hent alle brugere med denne rolle
    const { data: brugere, error: brugerFejl } = await supabase
      .from("users")
      .select("id, rolle");
    if (brugerFejl) throw brugerFejl;

    const modtagere = brugere.filter(b =>
      (Array.isArray(b.rolle) ? b.rolle.includes(målrolle) : b.rolle === målrolle)
      && b.id !== afsender // undgå at afsender får notifikation
    );

// 5. Tjek og indsæt notifikationer for modtagere
for (const modtager of modtagere) {
  const { data: eksisterende } = await supabase
    .from("kontakt_notifications")
    .select("id")
    .eq("thread_id", thread_id)
    .eq("bruger_id", modtager.id);

  if (!eksisterende.length) {
    await supabase.from("kontakt_notifications").insert({
      id: uuidv4(),
      bruger_id: modtager.id,
      thread_id
    });
  }
}

// 6. Opret notifikation til oprindelig afsender, hvis modtageren svarer tilbage
if (afsender !== tråd.oprettet_af) {
  const { data: eksisterende } = await supabase
    .from("kontakt_notifications")
    .select("id")
    .eq("thread_id", thread_id)
    .eq("bruger_id", tråd.oprettet_af);

  if (!eksisterende.length) {
    await supabase.from("kontakt_notifications").insert({
      id: uuidv4(),
      bruger_id: tråd.oprettet_af,
      thread_id
    });
  }
}

    res.json({ success: true });
  } catch (err) {
    console.error("Fejl i /reply:", err);
    res.status(500).json({ error: "Kunne ikke sende svar" });
  }
});

// ==== Arkivér tråde ====
app.post("/archive-thread", async (req, res) => {
  const { thread_id, lukket_af } = req.body;

  if (!thread_id || !lukket_af) {
    return res.status(400).json({ error: "thread_id og lukket_af påkrævet" });
  }

  try {
    // 1. Opdater tråd med lukket_af og er_lukket = true
    const { error: updateError } = await supabase
      .from("threads")
      .update({ er_lukket: true, lukket_af })
      .eq("id", thread_id);
    if (updateError) throw updateError;

    // 2. Hent navn og info på den der lukker
    const { data: lukker, error: lukkerFejl } = await supabase
      .from("users")
      .select("id, navn")
      .eq("id", lukket_af)
      .single();
    if (lukkerFejl) throw lukkerFejl;

    const lukkerNavn = lukker?.navn || "Ukendt";

    // 3. Hent tråden for at finde afsenderen
    const { data: tråd, error: trådFejl } = await supabase
      .from("threads")
      .select("oprettet_af")
      .eq("id", thread_id)
      .single();
    if (trådFejl) throw trådFejl;

    const afsenderId = tråd.oprettet_af;

    // 5. Opret ny notifikation til afsender
    const { error: notifError } = await supabase
      .from("kontakt_notifications")
      .insert({
        id: uuidv4(),
        bruger_id: afsenderId,
        thread_id
      });

    if (notifError) {
      console.error("⚠️ Kunne ikke oprette notifikation:", notifError);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fejl i /archive-thread:", err);
    res.status(500).json({ error: "Kunne ikke arkivere tråd" });
  }
});

// ==== Notifikation på tråden ====
app.post("/mark-thread-read", async (req, res) => {
  const { thread_id, bruger_id } = req.body;

  if (!thread_id || !bruger_id) {
    return res.status(400).json({ error: "thread_id og bruger_id kræves" });
  }

  try {
    // Hent tråden for at afgøre om brugeren er afsender eller modtager
    const { data: tråd, error } = await supabase
      .from("threads")
      .select("oprettet_af")
      .eq("id", thread_id)
      .single();

    if (error || !tråd) throw error || new Error("Tråd ikke fundet");

    const felt =
      tråd.oprettet_af === bruger_id
        ? "sidst_set_af_afsender"
        : "sidst_set_af_modtager";

    const { error: updateError } = await supabase
      .from("threads")
      .update({ [felt]: new Date().toISOString() })
      .eq("id", thread_id);

    if (updateError) throw updateError;

    // 🔔 Fjern notifikationen for denne bruger og tråd
    await supabase
      .from("kontakt_notifications")
      .delete()
      .eq("thread_id", thread_id)
      .eq("bruger_id", bruger_id);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fejl i /mark-thread-read:", err);
    res.status(500).json({ error: "Kunne ikke markere som læst" });
  }
});

// Slet en tråd
app.post("/delete-thread", async (req, res) => {
  const { thread_id, bruger_id } = req.body;
  if (!thread_id || !bruger_id) {
    return res.status(400).json({ error: "Mangler thread_id eller bruger_id" });
  }

  try {
    // Tjek at brugeren ejer tråden
    const { data: tråd, error } = await supabase
      .from("threads")
      .select("oprettet_af, er_lukket")
      .eq("id", thread_id)
      .single();

    if (error || !tråd) throw error || new Error("Tråd ikke fundet");

    if (tråd.oprettet_af !== bruger_id) {
      return res.status(403).json({ error: "Du må ikke slette denne tråd" });
    }

    if (!tråd.er_lukket) {
      return res.status(400).json({ error: "Tråden skal være lukket for at kunne slettes" });
    }

    // Slet beskeder
    await supabase.from("messages").delete().eq("thread_id", thread_id);
    // Slet notifikationer
    await supabase.from("kontakt_notifications").delete().eq("thread_id", thread_id);
    // Slet selve tråden
    await supabase.from("threads").delete().eq("id", thread_id);

    res.json({ success: true });
  } catch (err) {
    console.error("Fejl ved sletning:", err);
    res.status(500).json({ error: "Kunne ikke slette tråden" });
  }
});

// ==== Oprettelse af bruger i adm.panel ====
app.post('/create-user', async (req, res) => {
  const { navn, email, rolle } = req.body;
  if (!navn || !email || !rolle) {
    return res.status(400).json({ error: 'Manglende felter' });
  }

  try {
    // Opret brugeren uden at sende e-mail
    const { data, error: signupError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true
    });

    if (signupError) throw signupError;

    const brugerId = data.user.id;

    // Tilføj til users-tabel
    const { error: dbError } = await supabase
      .from("users")
      .insert([{ id: brugerId, navn, rolle }]);

    if (dbError) throw dbError;

    // Generér recovery-link (manuelt sendt link til adgangskode)
    const { data: recoveryData, error: recoveryError } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email
    });

    if (recoveryError) throw recoveryError;

    // Send recovery-link med tilbage
    res.json({
      success: true,
      userId: brugerId,
      recoveryLink: recoveryData.action_link
    });

  } catch (err) {
    console.error("Fejl i oprettelse:", err);
    res.status(500).json({ error: err.message || "Ukendt fejl" });
  }
});

// ==== Sletning af bruger i adm.panel ====
app.post('/delete-user', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Mangler bruger-id" });

  try {
    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) throw authErr;

    const { error: dbErr } = await supabase.from("users").delete().eq("id", id);
    if (dbErr) throw dbErr;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Ukendt fejl" });
  }
});

// ==== Kontaktformular + notifikation + threadoprettelse ====
app.post("/kontakt", async (req, res) => {
  console.log("🔥 Modtog POST /kontakt");

  const { rolle, titel, afsender, tekst, billede_url, lyd_url } = req.body;

  if (!rolle || !titel || !afsender || (!tekst && !billede_url && !lyd_url)) {
    return res.status(400).json({ error: "Manglende nødvendige felter" });
  }

  const threadId = uuidv4();

  const { error: threadError } = await supabase
    .from("threads")
    .insert({
      id: threadId,
      rolle,
      titel,
      oprettet_af: afsender
    });

  if (threadError) {
    console.error("❌ Trådfejl:", threadError);
    return res.status(500).json({ error: "Kunne ikke oprette tråd" });
  }

  const { error: messageError } = await supabase
    .from("messages")
    .insert({
      thread_id: threadId,
      afsender,
      tekst,
      billede_url,
      lyd_url
    });

  if (messageError) {
    console.error("❌ Beskedfejl:", messageError);
    return res.status(500).json({ error: "Kunne ikke oprette besked" });
  }

  const { data: brugere, error: userError } = await supabase
    .from("users")
    .select("id, rolle");

  if (userError) {
    console.error("❌ Fejl ved hentning af brugere:", userError);
    return res.status(500).json({ error: "Kunne ikke hente brugere" });
  }

  const modtagere = brugere.filter(b => 
    Array.isArray(b.rolle) ? b.rolle.includes(rolle) : b.rolle === rolle
  );

  const notifikationer = modtagere.map(b => ({
    id: uuidv4(),
    bruger_id: b.id,
    thread_id: threadId
  }));

  if (notifikationer.length > 0) {
    const { error: notifError } = await supabase
      .from("kontakt_notifications")
      .insert(notifikationer);

    if (notifError) {
      console.error("❌ Fejl ved notifikationer:", notifError);
    }
  }

  res.json({ success: true, threadId });
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`✅ Server kører på http://localhost:${PORT}`);
});
