// server.js (Supabase only, no Google deps)
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

// ===== Env =====
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000,
  NODE_ENV
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Mangler SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// Service‑rolle klient (kan bruge auth.admin og læse alle tabeller)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ===== App & CORS =====
const app = express();

const tilladteOrigins = [
  "http://localhost:8080",
  "http://localhost:5173",
  "https://nglevagter-test.netlify.app",
  // tilføj produktionsdomæner her:
  // "https://nkl.dk",
];

function originMatcher(origin) {
  if (!origin) return true; // fx curl/mobile webviews
  if (tilladteOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname.endsWith(".netlify.app")) return true; // build previews
  } catch {}
  return false;
}

const corsOptions = {
  origin: (origin, cb) => (originMatcher(origin) ? cb(null, true) : cb(new Error("Ikke tilladt af CORS: " + origin))),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// ===== Auth helpers =====
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Manglende token" });

    // Valider access token → få auth user
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) return res.status(401).json({ error: "Ugyldigt token" });

    const sessionUserId = userRes.user.id;

    // Tjek i dit users‑table om rollen er admin
    const { data: me, error: meErr } = await supabase
      .from("users")
      .select("id, navn, rolle")
      .eq("id", sessionUserId)
      .maybeSingle();

    if (meErr || !me) return res.status(403).json({ error: "Bruger ikke fundet i users" });

    const roller = Array.isArray(me.rolle) ? me.rolle : (me.rolle ? [me.rolle] : []);
    if (!roller.includes("admin")) return res.status(403).json({ error: "Kræver admin-rolle" });

    req.adminUser = me;
    next();
  } catch (e) {
    console.error("requireAdmin fejl:", e);
    res.status(500).json({ error: "Serverfejl i adgangskontrol" });
  }
}

// ===== GDPR helpers (maskering) =====
function cleanOwnMessage(m) {
  return {
    id: m.id ?? null,
    thread_id: m.thread_id,
    afsender: m.afsender,
    tekst: m.tekst ?? null,
    billede_url: m.billede_url ?? null,
    lyd_url: m.lyd_url ?? null,
    tidspunkt: m.tidspunkt ?? m.created_at ?? null,
    er_arkiveret: !!m.er_arkiveret,
  };
}

function summarizeOtherMessage(m) {
  return {
    id: m.id ?? null,
    thread_id: m.thread_id,
    other_participant: true,
    tidspunkt: m.tidspunkt ?? m.created_at ?? null,
    has_billede: !!m.billede_url,
    has_lyd: !!m.lyd_url,
    er_arkiveret: !!m.er_arkiveret,
  };
}

function redactThreadMeta(t, userId) {
  return {
    id: t.id,
    titel: t.titel ?? null,
    rolle: t.rolle ?? null,
    modtager: t.modtager === userId ? userId : (t.modtager ? "redacted" : null),
    oprettet_af: t.oprettet_af === userId ? userId : (t.oprettet_af ? "redacted" : null),
    created_at: t.created_at ?? t.oprettet_dato ?? null,
    opdateret: t.opdateret ?? null,
    er_lukket: typeof t.er_lukket === "boolean" ? t.er_lukket : !!t.lukket,
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
    messages: [...mine, ...andres].sort((a, b) => new Date(a.tidspunkt) - new Date(b.tidspunkt)),
  };
}

async function buildGdprPayloadByUserId(userId, { includeSystemMeta }) {
  // Profil
  const { data: profile, error: profileErr } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();
  if (profileErr || !profile) return { error: "Bruger ikke fundet i users" };

  // Tråde hvor brugeren er part
  const [{ data: threadsInitiated }, { data: threadsDirect }] = await Promise.all([
    supabase.from("threads")
      .select("id, titel, rolle, oprettet_af, modtager, created_at, opdateret, er_lukket, lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager, oprettet_dato, genåbnet_af")
      .eq("oprettet_af", userId),
    supabase.from("threads")
      .select("id, titel, rolle, oprettet_af, modtager, created_at, opdateret, er_lukket, lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager, oprettet_dato, genåbnet_af")
      .eq("modtager", userId),
  ]);

  const directIds = [
    ...(threadsInitiated?.map(t => t.id) || []),
    ...(threadsDirect?.map(t => t.id) || []),
  ];
  const uniqueDirectIds = [...new Set(directIds)];

  // Beskeder for de tråde
  const msgsByThread = {};
  if (uniqueDirectIds.length) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, thread_id, afsender, tekst, billede_url, lyd_url, tidspunkt, er_arkiveret")
      .in("thread_id", uniqueDirectIds)
      .order("tidspunkt", { ascending: true });
    (msgs || []).forEach(m => (msgsByThread[m.thread_id] ||= []).push(m));
  }

  // Egne beskeder (uanset tråd)
  const { data: messagesAuthored } = await supabase
    .from("messages")
    .select("id, thread_id, afsender, tekst, billede_url, lyd_url, tidspunkt, er_arkiveret")
    .eq("afsender", userId)
    .order("tidspunkt", { ascending: true });

  // Rolletråde hvor brugeren har skrevet (så egne beskeder er med)
  const authoredThreadIds = [...new Set((messagesAuthored || []).map(m => m.thread_id))];
  let roleThreads = [];
  if (authoredThreadIds.length) {
    const directSet = new Set(uniqueDirectIds);
    const { data: authoredThreads } = await supabase
      .from("threads")
      .select("id, titel, rolle, oprettet_af, modtager, created_at, opdateret, er_lukket, lukket, lukket_af, sidst_set_af_afsender, sidst_set_af_modtager, oprettet_dato, genåbnet_af")
      .in("id", authoredThreadIds);
    roleThreads = (authoredThreads || []).filter(t => !directSet.has(t.id));

    if (roleThreads.length) {
      const extraIds = roleThreads.map(t => t.id);
      const { data: extraMsgs } = await supabase
        .from("messages")
        .select("id, thread_id, afsender, tekst, billede_url, lyd_url, tidspunkt, er_arkiveret")
        .in("thread_id", extraIds)
        .order("tidspunkt", { ascending: true });
      (extraMsgs || []).forEach(m => (msgsByThread[m.thread_id] ||= []).push(m));
    }
  }

  // Notifikationer til brugeren
  const { data: kontaktNotifs } = await supabase
    .from("kontakt_notifications")
    .select("id, bruger_id, thread_id, ulæst")
    .eq("bruger_id", userId);

  // Messenger blok (maskeret)
  const messenger = {
    threads_initiated: (threadsInitiated || []).map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    ),
    direct_threads_received: (threadsDirect || []).map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    ),
    messages_authored: (messagesAuthored || []).map(cleanOwnMessage),
    notifications: kontaktNotifs || [],
  };

  if (roleThreads.length) {
    messenger.role_threads_participated = roleThreads.map(t =>
      redactThreadWithMessages(t, msgsByThread[t.id] || [], userId)
    );
  }

  // (Valgfrit) andre Supabase‑kilder (fx rutelog, tilmeldinger mv.) kan tilføjes her

  return {
    payload: {
      meta: {
        exportGeneratedAt: new Date().toISOString(),
        includeSystemMeta: !!includeSystemMeta,
        source: "NKL Adminpanel",
        version: 4,
      },
      subject: {
        id: profile.id,
        navn: profile.navn ?? null,
        email: profile.email ?? null,
        rolle: profile.rolle ?? null,
        oprettet_dato: profile.oprettet_dato ?? null,
      },
      data: {
        messenger,
      },
      raw: {
        users_row: profile,
      },
    },
  };
}

// ===== Routes =====

// --- GDPR export (admin) ---
app.get("/gdpr-export", requireAdmin, async (req, res) => {
  const { lookupType = "userId", lookupValue = "", includeSystemMeta = "0" } = req.query;
  if (!lookupValue) return res.status(400).json({ error: "lookupValue påkrævet" });

  try {
    // Slå bruger op i users
    let subject = null;
    if (lookupType === "email") {
      const { data } = await supabase
        .from("users")
        .select("id, navn, email, rolle, oprettet_dato")
        .ilike("email", lookupValue)
        .maybeSingle();
      if (data) subject = data;
    } else {
      const { data } = await supabase
        .from("users")
        .select("id, navn, email, rolle, oprettet_dato")
        .eq("id", lookupValue)
        .maybeSingle();
      if (data) subject = data;
    }

    // Fallback til auth‑user hvis ikke i users
    if (!subject) {
      if (lookupType === "userId") {
        const { data: au } = await supabase.auth.admin.getUserById(lookupValue);
        if (au?.user) {
          subject = {
            id: au.user.id,
            navn: null,
            email: au.user.email ?? null,
            rolle: null,
            oprettet_dato: au.user.created_at ?? null,
          };
        }
      } else {
        // lookup via email
        const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const au = list?.users?.find(u => (u.email || "").toLowerCase() === lookupValue.toLowerCase());
        if (au) {
          subject = {
            id: au.id,
            navn: null,
            email: au.email ?? null,
            rolle: null,
            oprettet_dato: au.created_at ?? null,
          };
        }
      }
    }

    if (!subject) return res.status(404).json({ error: `Bruger (${lookupType}) ikke fundet` });

    const { payload, error } = await buildGdprPayloadByUserId(subject.id, { includeSystemMeta: includeSystemMeta === "1" });
    const finalPayload = error ? {
      meta: {
        exportGeneratedAt: new Date().toISOString(),
        includeSystemMeta: includeSystemMeta === "1",
        source: "NKL Adminpanel",
        version: 4,
      },
      subject,
      data: { messenger: {} },
      raw: { users_row: null },
    } : payload;

    const safeName = (subject.navn || subject.email || "bruger").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
    const filename = `gdpr_${safeName}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(JSON.stringify(finalPayload, null, 2));
  } catch (e) {
    console.error("GDPR eksport fejl:", e);
    res.status(500).json({ error: "Uventet serverfejl ved GDPR-eksport" });
  }
});

// --- Messenger: tråde (afsender + rolle + direkte) ---
app.get("/threads", async (req, res) => {
  const brugerId = req.query.brugerId;
  if (!brugerId) return res.status(400).json({ error: "brugerId mangler" });

  try {
    // brugerens roller (kan være nyttigt til fremtidige rolle‑tråde)
    const { data: brugerdata } = await supabase
      .from("users")
      .select("rolle")
      .eq("id", brugerId)
      .single();
    const brugerRoller = Array.isArray(brugerdata?.rolle) ? brugerdata.rolle : (brugerdata?.rolle ? [brugerdata.rolle] : []);

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

    const [{ data: afsendte }, { data: direkte }] = await Promise.all([
      supabase.from("threads").select(felt).eq("oprettet_af", brugerId),
      supabase.from("threads").select(felt).eq("modtager", brugerId),
    ]);

    // (Valgfrit) rolle‑tråde til brugerens roller kan tilføjes her

    const map = new Map();
    [...(afsendte||[]), ...(direkte||[])].forEach(t => map.set(t.id, t));
    res.json([...map.values()]);
  } catch (err) {
    console.error("❌ /threads fejl:", err);
    res.status(500).json({ error: "Serverfejl" });
  }
});

// --- Messenger: svar i tråd ---
app.post("/reply", async (req, res) => {
  const { thread_id, afsender, tekst, billede_url, lyd_url } = req.body;
  if (!thread_id || !afsender || (!tekst && !billede_url && !lyd_url)) {
    return res.status(400).json({ error: "Manglende felter" });
  }
  try {
    const { error: msgError } = await supabase
      .from("messages")
      .insert([{ thread_id, afsender, tekst, billede_url, lyd_url }]);
    if (msgError) throw msgError;

    const { error: updateError } = await supabase
      .from("threads")
      .update({ opdateret: new Date().toISOString() })
      .eq("id", thread_id);
    if (updateError) throw updateError;

    // Notifikationer (direkte til modtager hvis findes)
    const { data: tråd } = await supabase
      .from("threads")
      .select("rolle, oprettet_af, modtager")
      .eq("id", thread_id)
      .single();

    if (tråd?.modtager && tråd.modtager !== afsender) {
      const { data: eksisterende } = await supabase
        .from("kontakt_notifications")
        .select("id")
        .eq("thread_id", thread_id)
        .eq("bruger_id", tråd.modtager);
      if (!eksisterende?.length) {
        await supabase.from("kontakt_notifications").insert({
          id: uuidv4(),
          bruger_id: tråd.modtager,
          thread_id
        });
      }
    } else if (tråd?.rolle) {
      const { data: brugere } = await supabase.from("users").select("id, rolle");
      const modtagere = (brugere || []).filter(b => {
        const r = Array.isArray(b.rolle) ? b.rolle : (b.rolle ? [b.rolle] : []);
        return r.includes(tråd.rolle) && b.id !== afsender;
      });
      for (const m of modtagere) {
        const { data: eksisterende } = await supabase
          .from("kontakt_notifications")
          .select("id")
          .eq("thread_id", thread_id)
          .eq("bruger_id", m.id);
        if (!eksisterende?.length) {
          await supabase.from("kontakt_notifications").insert({
            id: uuidv4(),
            bruger_id: m.id,
            thread_id
          });
        }
      }
    }

    // Notifikation til oprindelig afsender hvis modtager svarer
    if (afsender !== tråd?.oprettet_af) {
      const { data: eksisterende } = await supabase
        .from("kontakt_notifications")
        .select("id")
        .eq("thread_id", thread_id)
        .eq("bruger_id", tråd?.oprettet_af);
      if (!eksisterende?.length) {
        await supabase.from("kontakt_notifications").insert({
          id: uuidv4(),
          bruger_id: tråd?.oprettet_af,
          thread_id
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ /reply fejl:", err);
    res.status(500).json({ error: "Kunne ikke sende svar" });
  }
});

// --- Arkivér / genåbn / slet / markér læst ---
app.post("/archive-thread", async (req, res) => {
  const { thread_id, lukket_af } = req.body;
  if (!thread_id || !lukket_af) return res.status(400).json({ error: "thread_id og lukket_af påkrævet" });
  try {
    const { error } = await supabase.from("threads").update({ er_lukket: true, lukket_af }).eq("id", thread_id);
    if (error) throw error;

    // Notifikation til afsender
    const { data: tråd } = await supabase.from("threads").select("oprettet_af").eq("id", thread_id).single();
    await supabase.from("kontakt_notifications").insert({ id: uuidv4(), bruger_id: tråd.oprettet_af, thread_id });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /archive-thread fejl:", err);
    res.status(500).json({ error: "Kunne ikke arkivere tråd" });
  }
});

app.post("/reopen-thread", async (req, res) => {
  const { thread_id, bruger_id } = req.body;
  if (!thread_id || !bruger_id) return res.status(400).json({ error: "Manglende data" });
  try {
    const { error } = await supabase
      .from("threads")
      .update({ er_lukket: false, lukket_af: null, genåbnet_af: bruger_id })
      .eq("id", thread_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /reopen-thread fejl:", err);
    res.status(500).json({ error: "Kunne ikke genåbne tråd" });
  }
});

app.post("/delete-thread", async (req, res) => {
  const { thread_id, bruger_id } = req.body;
  if (!thread_id || !bruger_id) return res.status(400).json({ error: "Mangler thread_id eller bruger_id" });
  try {
    const { data: tråd } = await supabase
      .from("threads")
      .select("oprettet_af, er_lukket")
      .eq("id", thread_id)
      .single();
    if (!tråd) return res.status(404).json({ error: "Tråd ikke fundet" });
    if (tråd.oprettet_af !== bruger_id) return res.status(403).json({ error: "Du må ikke slette denne tråd" });
    if (!tråd.er_lukket) return res.status(400).json({ error: "Tråden skal være lukket for at kunne slettes" });

    await supabase.from("messages").delete().eq("thread_id", thread_id);
    await supabase.from("kontakt_notifications").delete().eq("thread_id", thread_id);
    await supabase.from("threads").delete().eq("id", thread_id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /delete-thread fejl:", err);
    res.status(500).json({ error: "Kunne ikke slette tråden" });
  }
});

app.post("/mark-thread-read", async (req, res) => {
  const { thread_id, bruger_id } = req.body;
  if (!thread_id || !bruger_id) return res.status(400).json({ error: "thread_id og bruger_id kræves" });
  try {
    const { data: tråd } = await supabase.from("threads").select("oprettet_af").eq("id", thread_id).single();
    if (!tråd) return res.status(404).json({ error: "Tråd ikke fundet" });
    const felt = tråd.oprettet_af === bruger_id ? "sidst_set_af_afsender" : "sidst_set_af_modtager";
    await supabase.from("threads").update({ [felt]: new Date().toISOString() }).eq("id", thread_id);
    await supabase.from("kontakt_notifications").delete().eq("thread_id", thread_id).eq("bruger_id", bruger_id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /mark-thread-read fejl:", err);
    res.status(500).json({ error: "Kunne ikke markere som læst" });
  }
});

// --- Direkte kontakt (opret tråd + første besked) ---
app.post("/kontakt", async (req, res) => {
  const { afsender, modtager, rolle, titel, tekst, billede_url, lyd_url } = req.body;
  if (!afsender || !titel || (!tekst && !lyd_url)) {
    return res.status(400).json({ error: "Mangler påkrævede felter" });
  }
  try {
    const { data: thread, error: threadError } = await supabase
      .from("threads")
      .insert([{ oprettet_af: afsender, modtager: modtager || null, rolle: rolle || null, titel }])
      .select()
      .single();
    if (threadError) throw threadError;

    const { error: msgError } = await supabase
      .from("messages")
      .insert([{ thread_id: thread.id, afsender, tekst, billede_url, lyd_url }]);
    if (msgError) throw msgError;

    if (modtager) {
      await supabase.from("kontakt_notifications").insert([{ thread_id: thread.id, bruger_id: modtager }]);
    }
    res.status(200).json({ ok: true, thread_id: thread.id });
  } catch (err) {
    console.error("❌ /kontakt fejl:", err);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// --- Event tilmeldinger (Supabase version) ---
app.get("/signups", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("event_tilmeldinger")
      .select("event_id, bruger_id, navn, tilmeldt")
      .order("tilmeldt", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("❌ /signups fejl:", err);
    res.status(500).json({ error: "Serverfejl ved hentning af tilmeldinger" });
  }
});

app.get("/signups/:eventId", async (req, res) => {
  const { eventId } = req.params;
  try {
    const { data, error } = await supabase
      .from("event_tilmeldinger")
      .select("navn, bruger_id, tilmeldt")
      .eq("event_id", eventId)
      .order("tilmeldt", { ascending: true });
    if (error) throw error;
    res.json({ eventId, count: data?.length || 0, names: (data || []).map(r => r.navn).filter(Boolean) });
  } catch (err) {
    console.error("❌ /signups/:eventId fejl:", err);
    res.status(500).json({ error: "Serverfejl" });
  }
});

app.post("/signup", async (req, res) => {
  const { eventId, names, bruger_id } = req.body;
  if (!eventId || !names) return res.status(400).json({ error: "eventId og names påkrævet" });

  const list = Array.isArray(names) ? names : [names];
  try {
    const rows = list.map(navn => ({ id: uuidv4(), event_id: eventId, bruger_id: bruger_id || null, navn, tilmeldt: new Date().toISOString() }));
    const { error } = await supabase.from("event_tilmeldinger").insert(rows);
    if (error) throw error;
    res.json({ success: true, added: rows.length });
  } catch (err) {
    console.error("❌ /signup fejl:", err);
    res.status(500).json({ error: "Serverfejl under tilmelding" });
  }
});

app.post("/unsign", async (req, res) => {
  const { eventId, names } = req.body;
  if (!eventId || !names) return res.status(400).json({ error: "eventId og names påkrævet" });

  const inputNames = (Array.isArray(names) ? names : String(names).split(/\n|,/))
    .map(n => n.trim())
    .filter(Boolean);

  try {
    const { data: existing } = await supabase
      .from("event_tilmeldinger")
      .select("id, navn")
      .eq("event_id", eventId);

    const toDeleteIds = (existing || [])
      .filter(r => inputNames.includes((r.navn || "").trim()))
      .map(r => r.id);

    if (toDeleteIds.length === 0) {
      return res.json({ success: true, removed: 0, notFound: inputNames });
    }

    const { error } = await supabase.from("event_tilmeldinger").delete().in("id", toDeleteIds);
    if (error) throw error;

    const notFound = inputNames.filter(n => !(existing || []).some(r => (r.navn || "").trim() === n));
    res.json({ success: true, removed: toDeleteIds.length, notFound });
  } catch (err) {
    console.error("❌ /unsign fejl:", err);
    res.status(500).json({ error: "Serverfejl under framelding" });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ Server kører på port ${PORT} (${NODE_ENV || "dev"})`);
});
