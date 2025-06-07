import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';

const calendar = google.calendar({ version: 'v3', auth: new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
}) });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const spreadsheetId = process.env.SPREADSHEET_ID;
const sheetName = 'Sheet1';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
      const isoDate = date.toISOString().split('T')[0];

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
        events: matchingEvents.map(ev => ev.summary)
      };
    }

    res.json(result);
  } catch (err) {
    console.error('Fejl i assignments-with-events:', err);
    res.status(500).json({ error: 'Fejl ved hentning af data' });
  }
});

app.post('/assignments', async (req, res) => {
  const { day, name } = req.body;

  if (typeof day !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'Ugyldige data' });
  }

  try {
    await updateSheetEntry(day, name);
    res.json({ success: true });
  } catch (err) {
    console.error('Fejl ved opdatering:', err);
    res.status(500).json({ error: 'Kunne ikke opdatere' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server kører på http://localhost:${PORT}`);
});
