import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from "uuid";
import jwt from 'jsonwebtoken';
import { pipeline } from "stream";
import { promisify } from "util";
import mime from "mime-types";

const streamPipeline = promisify(pipeline);

// ===== Express App Setup =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Supabase database =====
// Brug service key (server-side)
const supabase = createClient(
  'https://cianxaxaphvrutmstydr.supabase.co',
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
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

// ===== CORS (placeret TIDLIGT) =====
const tilladteOrigins = [
  'http://localhost:8080',
  'https://nglevagter-test.netlify.app',
  // tilføj jeres evt. prod-domæne(r) her:
  'https://nkl.dk'
];

function originMatcher(origin) {
  if (!origin) return true;                       // tillad curl/webviews
  if (tilladteOrigins.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.netlify.app')) return true; // allow deploy previews
  } catch {}
  return false;
}

const corsOptions = {
  origin: (origin, cb) => {
    if (originMatcher(origin)) return cb(null, true);
    return cb(new Error('Ikke tilladt af CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'], // så klienten kan læse filnavn
  optionsSuccessStatus: 204,
  preflightContinue: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // svar altid korrekt på preflight

// Øvrige middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// ===== Admin-beskyttelse (brug SUPABASE SERVICE KEY-klienten) =====
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Manglende token' });

    // Valider token og find bruger
    const { data: userData, error: getUserErr } = await supabase.auth.getUser(token);
    if (getUserErr || !userData?.user) return res.status(401).json({ error: 'Ugyldigt token' });

    const sessionUserId = userData.user.id;

    const { data: me, error: meErr } = await supabase
      .from('users')
      .select('id, navn, rolle')
      .eq('id', sessionUserId)
      .single();

    if (meErr || !me) return res.status(403).json({ error: 'Bruger ikke fundet i users' });

    const roller = Array.isArray(me.rolle) ? me.rolle : (me.rolle ? [me.rolle] : []);
    if (!roller.includes('admin')) return res.status(403).json({ error: 'Kræver admin-rolle' });

    req.adminUser = me;
    next();
  } catch (e) {
    console.error('requireAdmin fejl:', e);
    res.status(500).json({ error: 'Serverfejl i adgangskontrol' });
  }
}

// ===== Hjælpere til GDPR =====
function suggestFilename(base) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${base}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

async function buildGdprPayloadByUserId(userId, { includeSystemMeta }) {
  // --- 1) Profil
  const { data: profile, error: profileErr } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileErr || !profile) return { error: 'Bruger ikke fundet i users' };

  // --- 2) Messenger: tråde hvor brugeren er direkte part
  const [{ data: threadsInitiated }, { data: threadsDirect }] = await Promise.all([
    supabase.from('threads')
      .select('id, titel, rolle, modtager, oprettet_af, created_at, opdateret, er_lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager')
      .eq('oprettet_af', userId),
    supabase.from('threads')
      .select('id, titel, rolle, modtager, oprettet_af, created_at, opdateret, er_lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager')
      .eq('modtager', userId)
  ]);

  const directThreadIds = [
    ...(threadsInitiated?.map(t => t.id) || []),
    ...(threadsDirect?.map(t => t.id) || [])
  ];
  const uniqueDirectThreadIds = [...new Set(directThreadIds)];

  // Beskeder i disse tråde
  let msgsByThread = {};
  if (uniqueDirectThreadIds.length > 0) {
    const { data: msgsInDirect } = await supabase
      .from('messages')
      .select('*')
      .in('thread_id', uniqueDirectThreadIds)
      .order('sendt', { ascending: true });

    (msgsInDirect || []).forEach(m => {
      (msgsByThread[m.thread_id] ||= []).push(m);
    });
  }

  // Alle brugerens egne beskeder (uanset tråd)
  const { data: messagesAuthored } = await supabase
    .from('messages')
    .select('*')
    .eq('afsender', userId)
    .order('sendt', { ascending: true });

  // Notifikationer til brugeren
  const { data: kontaktNotifs } = await supabase
    .from('kontakt_notifications')
    .select('*')
    .eq('bruger_id', userId);

  // Rolletråde hvor brugeren har skrevet (så brugeren får sin egen tekst med)
  const threadIdsFromAuthored = [...new Set((messagesAuthored || []).map(m => m.thread_id))];
  let roleThreads = [];
  if (threadIdsFromAuthored.length) {
    const directSet = new Set(uniqueDirectThreadIds);
    const { data: authoredThreads } = await supabase
      .from('threads')
      .select('id, titel, rolle, modtager, oprettet_af, created_at, opdateret, er_lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager')
      .in('id', threadIdsFromAuthored);

    roleThreads = (authoredThreads || []).filter(t => !directSet.has(t.id));

    if (roleThreads.length) {
      const extraIds = roleThreads.map(t => t.id);
      const { data: extraMsgs } = await supabase
        .from('messages')
        .select('*')
        .in('thread_id', extraIds)
        .order('sendt', { ascending: true });
      (extraMsgs || []).forEach(m => {
        (msgsByThread[m.thread_id] ||= []).push(m);
      });
    }
  }

  // Redigerede/maske‑tråde
  const messenger = {
    threads_initiated: (threadsInitiated || []).map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    ),
    direct_threads_received: (threadsDirect || []).map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    ),
    // brugerens egne beskeder fuldt ud (egne data)
    messages_authored: (messagesAuthored || []).map(cleanOwnMessage),
    notifications: kontaktNotifs || []
  };

  if (roleThreads.length) {
    messenger.role_threads_participated = roleThreads.map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    );
  }

  // --- 3) Eksterne signups (Render) — uændret
  let renderSignups = [];
  try {
    if (profile?.navn) {
      const resp = await fetch('https://nglevagter-test.onrender.com/signups');
      if (resp.ok) {
        const all = await resp.json();
        renderSignups = all.filter(s => (s.name || '').toLowerCase() === profile.navn.toLowerCase());
      }
    }
  } catch (_) {}

  // --- 4) Payload
  const payload = {
    meta: {
      exportGeneratedAt: new Date().toISOString(),
      includeSystemMeta: !!includeSystemMeta,
      source: 'NKL Adminpanel',
      version: 3
    },
    subject: {
      id: profile.id,
      navn: profile.navn ?? null,
      email: profile.email ?? null,
      rolle: profile.rolle ?? null,
      oprettet_dato: profile.oprettet_dato ?? null
    },
    data: {
      renderSignups,
      messenger
    },
    raw: {
      users_row: profile
    }
  };

  if (includeSystemMeta) {
  }

  return { payload };
}


function cleanOwnMessage(m) {
  return {
    id: m.id ?? null,
    thread_id: m.thread_id,
    afsender: m.afsender,
    tekst: m.tekst ?? null,
    billede_url: m.billede_url ?? null,
    lyd_url: m.lyd_url ?? null,
    sendt: m.sendt ?? m.created_at ?? null
  };
}

function summarizeOtherMessage(m) {
  return {
    id: m.id ?? null,
    thread_id: m.thread_id,
    other_participant: true,
    // ingen tekst, ingen afsender-id
    sendt: m.sendt ?? m.created_at ?? null,
    has_billede: !!m.billede_url,
    has_lyd: !!m.lyd_url,
  };
}

function redactThreadMeta(t, userId) {
  return {
    id: t.id,
    titel: t.titel ?? null,
    rolle: t.rolle ?? null,                                   
    modtager: t.modtager === userId ? userId : (t.modtager ? "redacted" : null),
    oprettet_af: t.oprettet_af === userId ? userId : (t.oprettet_af ? "redacted" : null),
    created_at: t.created_at ?? null,
    opdateret: t.opdateret ?? null,
    er_lukket: !!t.er_lukket,
    lukket_af: t.lukket_af === userId ? userId : (t.lukket_af ? "redacted" : null),
    sidst_set_af_afsender: t.oprettet_af === userId ? (t.sidst_set_af_afsender ?? null) : null,
    sidst_set_af_modtager: t.modtager === userId ? (t.sidst_set_af_modtager ?? null) : null,
  };
}

function redactThreadWithMessages(t, msgs, userId) {
  const mine = (msgs || []).filter(m => m.afsender === userId).map(cleanOwnMessage);
  const andres = (msgs || []).filter(m => m.afsender !== userId).map(summarizeOtherMessage);
  return {
    ...redactThreadMeta(t, userId),
    messages: [...mine, ...andres].sort((a, b) => new Date(a.sendt) - new Date(b.sendt))
  };
}

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

// ===== GDPR-export (Render) =====
app.get('/gdpr-export', requireAdmin, async (req, res) => {
  const { lookupType = 'userId', lookupValue = '', includeSystemMeta = '0' } = req.query;
  if (!lookupValue) return res.status(400).json({ error: 'lookupValue påkrævet' });

  try {
    // 1) Prøv at finde i jeres egen 'users' tabel
    let subject = null;

    if (lookupType === 'email') {
      const { data } = await supabase
        .from('users')
        .select('id, navn, email, rolle, oprettet_dato')
        .ilike('email', lookupValue)
        .maybeSingle();
      if (data) subject = data;
    } else {
      const { data } = await supabase
        .from('users')
        .select('id, navn, email, rolle, oprettet_dato')
        .eq('id', lookupValue)
        .maybeSingle();
      if (data) subject = data;
    }

    // 2) Fallback: hvis ikke fundet i 'users', så hent auth-profilen
    //    (kræver SERVICE KEY; v2 API)
    let authUser = null;
    if (!subject) {
      if (lookupType === 'userId') {
        const { data: au, error: auErr } = await supabase.auth.admin.getUserById(lookupValue);
        if (au) authUser = au.user;
      } else {
        // lookupType=email → find auth user via listUsers (simpelt filter)
        const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        authUser = list?.users?.find(u => (u.email || '').toLowerCase() === lookupValue.toLowerCase()) || null;
      }
      if (!subject && authUser) {
        subject = {
          id: authUser.id,
          navn: null,
          email: authUser.email || null,
          rolle: null,
          oprettet_dato: authUser.created_at || null
        };
      }
    }

    // 3) Hvis stadig intet → 404
    if (!subject) {
      return res.status(404).json({ error: `Bruger (${lookupType}) ikke fundet` });
    }

    // 4) Byg payload (din eksisterende helper)
    const { payload, error } = await buildGdprPayloadByUserId(subject.id, { includeSystemMeta: includeSystemMeta === '1' });

    // Hvis helperen ikke finder users-row, så byg et minimums-payload her
    const finalPayload = error ? {
      meta: {
        exportGeneratedAt: new Date().toISOString(),
        includeSystemMeta: includeSystemMeta === '1',
        source: 'NKL Adminpanel',
        version: 1
      },
      subject: {
        id: subject.id,
        navn: subject.navn,
        email: subject.email,
        rolle: subject.rolle,
        oprettet_dato: subject.oprettet_dato
      },
      data: { renderSignups: [] },
      raw: { users_row: null, auth_user: authUser || null }
    } : payload;

    const safeName = (subject.navn || subject.email || 'bruger').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const filename = suggestFilename(`gdpr_${safeName}`);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(JSON.stringify(finalPayload, null, 2));
  } catch (e) {
    console.error('GDPR eksport fejl:', e);
    res.status(500).json({ error: 'Uventet serverfejl ved GDPR-eksport' });
  }
});


// ===== Signups & øvrige ruter (uændret) =====
app.get('/signups', async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const sheetsClient = google.sheets({ version: 'v4', auth: authClient });

    const result = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet2!A:B',
    });

    const rows = result.data.values || [];
    const data = rows.map(([eventId, name]) => ({ eventId, name }));
    res.json(data);
  } catch (err) {
    console.error('Fejl ved hentning af tilmeldinger:', err);
    res.status(500).json({ error: 'Serverfejl ved hentning af tilmeldinger' });
  }
});

app.post('/assignments', async (req, res) => {
  const { day, days, name } = req.body;

  if (typeof name !== 'string' || (!Array.isArray(days) && typeof day !== 'string')) {
    return res.status(400).json({ error: 'Ugyldige data' });
  }

  try {
    if (Array.isArray(days)) {
      for (const d of days) await updateSheetEntry(d, name);
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
  if (!eventId) return res.status(400).json({ error: 'eventId mangler' });
  try {
    const authClient = await calendarAuth.getClient();
    const calendarId = process.env.CLUB_CALENDAR_ID;
    await calendar.events.delete({ calendarId, eventId, auth: authClient });
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
      end: { date: getNextDate(endDate) },
    };
    const calendarId = process.env.CLUB_CALENDAR_ID;
    await calendar.events.insert({ calendarId, resource: event, auth: authClient });
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

    const matching = events.data.items.find(ev => ev.summary?.toLowerCase().startsWith('lukket'));
    if (matching) {
      await calendar.events.delete({ calendarId, eventId: matching.id, auth: authClient });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Fejl ved sletning af lukket-begivenhed:', err);
    res.status(500).json({ error: 'Kunne ikke fjerne begivenhed' });
  }
});

app.post('/signup', async (req, res) => {
  const { eventId, names } = req.body;
  if (!eventId || !names || (typeof names === 'string' && names.trim() === '')) {
    return res.status(400).json({ error: 'eventId og names påkrævet' });
  }
  const nameList = Array.isArray(names) ? names : [names];
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const values = nameList.map(name => [eventId, name]);
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet2!A:B',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    res.json({ success: true, updated: response.data });
  } catch (err) {
    console.error('Fejl i signup:', err);
    res.status(500).json({ error: 'Serverfejl under tilmelding' });
  }
});

app.post('/unsign', async (req, res) => {
  const { eventId, names } = req.body;
  if (!eventId || !names) return res.status(400).json({ error: 'eventId og names påkrævet' });

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const sheet = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet2!A:B' });

  const rows = sheet.data.values || [];
  const inputNames = names.split(/\n|,/).map(n => n.trim().toLowerCase()).filter(Boolean);
  const signedUp = rows.filter(([id]) => id === eventId);
  const signedUpNames = signedUp.map(([, name]) => (name || '').trim().toLowerCase());
  const updated = rows.filter(([id, name]) => !(id === eventId && inputNames.includes((name || '').trim().toLowerCase())));

  while (updated.length < rows.length) updated.push(['', '']);

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: 'Sheet2!A1:B', valueInputOption: 'RAW', resource: { values: updated }
  });

  const removed = signedUp.length - updated.filter(([id]) => id === eventId).length;
  res.json({ success: true, removed, notFound: inputNames.filter(n => !signedUpNames.includes(n)) });
});

app.get('/signups/:eventId', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId) return res.status(400).json({ error: 'eventId mangler' });
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet2!A:B' });
    const rows = result.data.values || [];
    const names = rows.filter(row => row[0] === eventId).map(row => row[1]);
    res.json({ eventId, count: names.length, names });
  } catch (err) {
    console.error('Fejl ved hentning af tilmeldinger:', err);
    res.status(500).json({ error: 'Serverfejl under hentning af tilmeldinger' });
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
  if (!brugerId) return res.status(400).json({ error: "brugerId mangler i forespørgslen" });

  try {
    // 1) Find brugerens roller
    const { data: brugerdata, error: brugerFejl } = await supabase
      .from("users")
      .select("rolle")
      .eq("id", brugerId)
      .single();
    if (brugerFejl || !brugerdata) throw brugerFejl || new Error("Bruger ikke fundet");

    const brugerRoller = Array.isArray(brugerdata.rolle) ? brugerdata.rolle : [brugerdata.rolle];

    // Feltliste (tilføj 'modtager'!)
    const felt = `
      id,
      titel,
      rolle,
      modtager,
      oprettet_af,
      created_at,
      er_lukket,
      lukket_af,
      opdateret,
      sidst_set_af_afsender,
      sidst_set_af_modtager
    `;

    // Afsendte tråde
    const { data: afsendte, error: e1 } = await supabase
      .from("threads")
      .select(felt)
      .eq("oprettet_af", brugerId);
    if (e1) throw e1;

    // Tråde til brugerens roller
    const { data: tilRoller, error: e2 } = await supabase
      .from("threads")
      .select(felt)
      .in("rolle", brugerRoller)
      .neq("oprettet_af", brugerId);
    if (e2) throw e2;

    // Tråde med specifik modtager = brugerId
    const { data: direkte, error: e3 } = await supabase
      .from("threads")
      .select(felt)
      .eq("modtager", brugerId)
      .neq("oprettet_af", brugerId);
    if (e3) throw e3;

    // Merge + dedup
    const map = new Map();
    [...(afsendte || []), ...(tilRoller || []), ...(direkte || [])].forEach(t => map.set(t.id, t));
    res.json([...map.values()]);
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
  .select("rolle, oprettet_af, modtager")
  .eq("id", thread_id)
  .single();
if (trådFejl || !tråd) throw trådFejl || new Error("Tråd ikke fundet");

const målrolle = tråd.rolle;
const specifikModtager = tråd.modtager;

// 5) Notifikationer
if (specifikModtager) {
  // direkte tråd -> kun specifik modtager
  if (specifikModtager !== afsender) {
    const { data: eksisterende } = await supabase
      .from("kontakt_notifications")
      .select("id")
      .eq("thread_id", thread_id)
      .eq("bruger_id", specifikModtager);

    if (!eksisterende?.length) {
      await supabase.from("kontakt_notifications").insert({
        id: uuidv4(),
        bruger_id: specifikModtager,
        thread_id
      });
    }
  }
} else if (målrolle) {
  // rolle-baseret -> hold din nuværende logik
  const { data: brugere, error: brugerFejl } = await supabase
    .from("users")
    .select("id, rolle");
  if (brugerFejl) throw brugerFejl;

  const modtagere = brugere.filter(b =>
    (Array.isArray(b.rolle) ? b.rolle.includes(målrolle) : b.rolle === målrolle)
    && b.id !== afsender
  );

  for (const modtager of modtagere) {
    const { data: eksisterende } = await supabase
      .from("kontakt_notifications")
      .select("id")
      .eq("thread_id", thread_id)
      .eq("bruger_id", modtager.id);

    if (!eksisterende?.length) {
      await supabase.from("kontakt_notifications").insert({
        id: uuidv4(),
        bruger_id: modtager.id,
        thread_id
      });
    }
  }
}
    
// 6) Notifikation til oprindelig afsender hvis modtager svarer (behold nuværende)
if (afsender !== tråd.oprettet_af) {
  const { data: eksisterende } = await supabase
    .from("kontakt_notifications")
    .select("id")
    .eq("thread_id", thread_id)
    .eq("bruger_id", tråd.oprettet_af);

  if (!eksisterende?.length) {
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

// Genåben en lukket tråd
app.post("/reopen-thread", async (req, res) => {
  const { thread_id, bruger_id } = req.body;
  if (!thread_id || !bruger_id) {
    return res.status(400).json({ error: "Manglende data" });
  }

  try {
 const { error } = await supabase
    .from("threads")
    .update({
      er_lukket: false,
      lukket_af: null,
      genåbnet_af: bruger_id
    })
    .eq("id", thread_id);


    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Fejl i /reopen-thread:", err);
    res.status(500).json({ error: "Kunne ikke genåbne tråd" });
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

// ==== Opret brugerdatafil ====
app.get("/export-user/:id", async (req, res) => {
  const brugerId = req.params.id;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ fejl: "Manglende token." });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verificér token og få brugerens id
    const { sub: requesterId } = jwt.decode(token);

    // Hent brugerens roller
    const { data: requester, error: requesterError } = await supabase
      .from("users")
      .select("rolle")
      .eq("id", requesterId)
      .single();

    if (requesterError || !requester) {
      return res.status(403).json({ fejl: "Ugyldig bruger." });
    }

    const roller = Array.isArray(requester.rolle) ? requester.rolle : [requester.rolle];
    const tilladteRoller = ["admin", "bestyrelsesmedlem"];

    const harAdgang = roller.some(r => tilladteRoller.includes(r));
    if (!harAdgang) {
      return res.status(403).json({ fejl: "Ingen adgang." });
    }

    // === Fortsæt med eksporten ===

    const { data: profil, error: profilError } = await supabase
      .from("users")
      .select("id, navn, rolle, oprettet_dato")
      .eq("id", brugerId)
      .single();

    if (profilError || !profil) {
      return res.status(404).json({ fejl: "Bruger ikke fundet." });
    }

    const { data: signups } = await supabase
      .from("signups")
      .select("event_id, event_title, event_date, frameldt")
      .eq("bruger_id", brugerId);

    const tilmeldinger = (signups || []).map(s => ({
      begivenhed_id: s.event_id,
      titel: s.event_title,
      dato: s.event_date,
      status: s.frameldt ? "frameldt" : "tilmeldt",
      frameldt: !!s.frameldt
    }));

    const { data: threads } = await supabase
      .from("threads")
      .select("id, roller, oprettet, lukket")
      .eq("bruger_id", brugerId);

    const kontakttråde = [];

    for (const tråd of threads || []) {
      const { data: beskeder } = await supabase
        .from("messages")
        .select("afsender, indhold, sendt, vedhæftning")
        .eq("thread_id", tråd.id)
        .order("sendt", { ascending: true });

      kontakttråde.push({
        tråd_id: tråd.id,
        modtagere: tråd.roller,
        startet: tråd.oprettet,
        lukket: tråd.lukket,
        beskeder: beskeder || []
      });
    }

    const eksportData = {
      metadata: {
        eksport_tidspunkt: new Date().toISOString(),
        generator: "Næstved Klatreklub adminpanel"
      },
      brugerprofil: {
        ...profil,
        seneste_login: null
      },
      tilmeldinger,
      kontakttråde
    };

    res.setHeader("Content-Disposition", `attachment; filename=brugerdata-${brugerId}.json`);
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(eksportData, null, 2));
  } catch (err) {
    console.error("❌ Fejl i beskyttet eksport:", err);
    res.status(500).json({ fejl: "Intern serverfejl." });
  }
});



// ==== Kontaktformular + notifikation + threadoprettelse ====
app.post("/kontakt", async (req, res) => {
  const { afsender, modtager, rolle, titel, tekst, billede_url, lyd_url } = req.body;

  if (!afsender || !titel || (!tekst && !lyd_url)) {
    return res.status(400).json({ error: "Mangler påkrævede felter" });
  }

  try {
    const { data: thread, error: threadError } = await supabase
      .from("threads")
      .insert([{
        oprettet_af: afsender,
        modtager: modtager || null,
        rolle: rolle || null,
        titel
      }])
      .select()
      .single();

    if (threadError) throw threadError;

    const { error: msgError } = await supabase
      .from("messages")
      .insert([{
        thread_id: thread.id,
        afsender,
        tekst,
        billede_url,
        lyd_url
      }]);

    if (msgError) throw msgError;

    // Tilføj notifikation
    const notifikationsModtager = modtager || null;
    if (notifikationsModtager) {
      await supabase
        .from("kontakt_notifications")
        .insert([{ thread_id: thread.id, bruger_id: notifikationsModtager }]);
    }

    res.status(200).json({ ok: true, thread_id: thread.id });
  } catch (err) {
    console.error("Fejl i /kontakt:", err);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`✅ Server kører på http://localhost:${PORT}`);
});







