import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';

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
          const key = `${m + 1}-${d}`;
          days.push(key);
        }
      }
      return days;
    }

    const allKeys = getAllDaysInRange(2025, 5, 11);

for (const key of allKeys) {
  const [month, day] = key.split('-').map(Number);
  const date = new Date(2025, month - 1, day);
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
    name: assignments[key],
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
    const sheets = google.sheets({ version: "v4", auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet2!A:B",
    });

    const rows = result.data.values || [];
    const signups = rows.slice(1).map(([eventId, name]) => ({ eventId, name }));

    res.json(signups);
  } catch (err) {
    console.error("Fejl ved hentning af tilmeldinger:", err);
    res.status(500).json({ error: "Serverfejl" });
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

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`✅ Server kører på http://localhost:${PORT}`);
});
