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

async function getCalendarEventsForDate(date) {
  const calendarId = process.env.CLUB_CALENDAR_ID;
  const timeMin = new Date(date);
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(timeMin);
  timeMax.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return response.data.items.map(event => event.summary);
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
    const result = {};

    for (const key of Object.keys(assignments)) {
      const [month, day] = key.split('-').map(Number);
      const date = new Date(2025, month - 1, day);
      const events = await getCalendarEventsForDate(date);
      result[key] = { name: assignments[key], events };
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
