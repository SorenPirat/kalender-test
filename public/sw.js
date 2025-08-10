/// <reference lib="webworker" />

// Versionér dine caches når du shipper en ny release
const VERSION = "v1.0.0";
const STATIC_CACHE = `nkl-static-${VERSION}`;
const RUNTIME_CACHE = `nkl-runtime-${VERSION}`;
const IMMUTABLE_CACHE = `nkl-immutable-${VERSION}`;

// Justér til dit faktiske build-output
const APP_SHELL = [
  "/", // hvis du har client-side routing
  "/offline.html",
  "/manifest.webmanifest",
  // tilføj dine bundler-output-filer, fx:
  // "/assets/index.js",
  // "/assets/index.css",
];

// Domæner vi anser som "immutable" (langtidscache) – typisk CDN builds
const IMMUTABLE_PATTERNS = [/cdnjs\.cloudflare\.com/, /unpkg\.com/, /cdn\.jsdelivr\.net/];

// Supabase – tilpas til dit projekt
const SUPABASE_URL = self.location.origin; // vi matcher senere på host i request.url
const SUPABASE_HOST_HINTS = ["supabase.co", "supabase.in"];

// Hvilke API-stier vil vi forsøge at queue, når vi er offline?
const QUEUEABLE_PATHS = [
  "/rest/v1/event_tilmeldinger",
  "/rest/v1/messages"
];

// IndexedDB helper til outbox (meget letvægts – du kan erstatte med idb-keyval)
const DB_NAME = "nkl-outbox-db";
const STORE = "outbox";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function outboxAdd(payload: any) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(payload);
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => reject(tx.error);
  });
}

async function outboxDrain() {
  const db = await openDB();
  const items: any[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const all: any[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result as IDBCursorWithValue | null;
      if (!cur) return;
      all.push({ key: cur.key, value: cur.value });
      cur.continue();
    };
    tx.oncomplete = () => resolve(all);
    tx.onerror = () => reject(tx.error);
  });

  for (const { key, value } of items) {
    try {
      const { url, method, headers, body } = value as {
        url: string; method: string; headers: Record<string,string>; body: string | null
      };
      const res = await fetch(url, { method, headers, body });
      if (!res.ok) throw new Error(`Replay failed ${res.status}`);
      // Slet item når replay lykkes
      await new Promise((resolve, reject) => {
        openDB().then(db => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve(null);
          tx.onerror = () => reject(tx.error);
        });
      });
    } catch (e) {
      // stop tidligt; prøv igen næste sync
      break;
    }
  }
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      await staticCache.addAll(APP_SHELL);
      // Hurtig aktivering
      await (self as any).skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      // Ryd gamle caches
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => ![STATIC_CACHE, RUNTIME_CACHE, IMMUTABLE_CACHE].includes(k))
          .map(k => caches.delete(k))
      );
      (self as any).clients.claim();
    })()
  );
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") {
    (self as any).skipWaiting();
  }
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const req = event.request;
  const url = new URL(req.url);

  // Navigations: prøv netværk først -> offline fallback
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // cache en kopi til shell
          const cache = await caches.open(STATIC_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          const cached = await cache.match(req);
          if (cached) return cached;
          return cache.match("/offline.html");
        }
      })()
    );
    return;
  }

  // Immutable assets (CDN)
  if (IMMUTABLE_PATTERNS.some(rx => rx.test(url.hostname))) {
    event.respondWith(cacheFirst(req, IMMUTABLE_CACHE));
    return;
  }

  // Statics: css/js – stale-while-revalidate
  if (req.destination === "script" || req.destination === "style") {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // Images & fonts: cache-first
  if (req.destination === "image" || req.destination === "font") {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, { maxEntries: 150 }));
    return;
  }

  // Supabase REST/Storage – network-first, ingen caching for auth
  if (SUPABASE_HOST_HINTS.some(h => url.hostname.includes(h))) {
    if (url.pathname.startsWith("/auth/v1")) {
      // Aldrig cache auth
      event.respondWith(fetch(req));
      return;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        QUEUEABLE_PATHS.some(p => url.pathname.includes(p))) {
      // Forsøg netværk; ved fejl, læg i outbox og bed om sync
      event.respondWith(
        (async () => {
          try {
            return await fetch(req.clone());
          } catch {
            const headers: Record<string,string> = {};
            req.headers.forEach((v, k) => (headers[k] = v));
            const body = await req.clone().text();
            await outboxAdd({ url: req.url, method: req.method, headers, body });
            if ("sync" in (self as any).registration) {
              try { await (self as any).registration.sync.register("nkl-outbox-sync"); } catch {}
            }
            return new Response(JSON.stringify({ queued: true }), { status: 202, headers: { "Content-Type": "application/json" } });
          }
        })()
      );
      return;
    }

    // GET + andre – network-first med fallback til cache
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // Default: prøv SWR
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

self.addEventListener("sync", (event: any) => {
  if (event.tag === "nkl-outbox-sync") {
    event.waitUntil(outboxDrain());
  }
});

// --------- Cache helpers ---------
async function cacheFirst(req: Request, cacheName: string, opts?: { maxEntries?: number }) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  cache.put(req, fresh.clone());
  // (valgfrit) implementer LRU ved overskridelse af maxEntries
  return fresh;
}

async function networkFirst(req: Request, cacheName: string) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response("Offline og ingen cache", { status: 503 });
  }
}

async function staleWhileRevalidate(req: Request, cacheName: string) {
  const cache = await caches.open(cacheName);
  const cachedPromise = cache.match(req);
  const networkPromise = fetch(req)
    .then(res => {
      cache.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);

  const cached = await cachedPromise;
  return cached || (await networkPromise) || new Response("Offline", { status: 503 });
}