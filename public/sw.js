// ============================================================
// razkindo-erp-v1  —  High-Performance Service Worker
// ============================================================
// Next.js 16 · PWA · ARM64 STB + Mobile Clients
//
// Strategy breakdown:
//   • Pre-cache (install)    — critical app-shell assets
//   • Cache-first            — JS, CSS, fonts, images (static)
//   · Network-first          — /api/ calls
//   · Stale-while-revalidate — navigation / page requests
//   · Offline fallback       — built-in minimal HTML page
// ============================================================

const CACHE_NAME = "razkindo-erp-v1";
const MAX_CACHE_ENTRIES = 200;

// ── Pre-cache manifest (app shell) ──────────────────────────
// Extend this list with the exact hashes from your Next.js build
// once you integrate with next-pwa or workbox-webpack-plugin.
const PRECACHE_URLS = [
  "/",
  "/api/pwa/manifest",
  "/logo.svg",
  // Add versioned _next/static chunks here after first build:
  // "/_next/static/css/app-layout.css",
  // "/_next/static/chunks/webpack.js",
  // "/_next/static/chunks/main-app.js",
  // "/_next/static/chunks/framework.js",
];

// ── Offline fallback page (inline) ──────────────────────────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>RazKindo ERP — Offline</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;
  background:#f8fafc;color:#1e293b}
.box{text-align:center;padding:2.5rem;border-radius:1rem;
  background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;margin:1rem}
.icon{font-size:3.5rem;margin-bottom:.75rem}
h1{font-size:1.35rem;font-weight:700;margin-bottom:.5rem}
p{font-size:.95rem;color:#64748b;line-height:1.6;margin-bottom:1.25rem}
button{padding:.65rem 1.75rem;border:none;border-radius:.5rem;
  background:#2563eb;color:#fff;font-size:.95rem;font-weight:600;
  cursor:pointer;transition:background .2s}
button:hover{background:#1d4ed8}
button:active{background:#1e40af}
</style>
</head>
<body>
<div class="box">
  <div class="icon">&#128268;</div>
  <h1>You're Offline</h1>
  <p>RazKindo ERP is not available right now. Please check your internet connection and try again.</p>
  <button onclick="window.location.reload()">Try Again</button>
</div>
</body>
</html>`;

// ── Utility: cache size enforcement ─────────────────────────
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_ENTRIES) {
    // Delete oldest entries beyond the limit (FIFO)
    const deleteCount = keys.length - MAX_CACHE_ENTRIES;
    const deletion = keys.slice(0, deleteCount).map((req) => cache.delete(req));
    await Promise.all(deletion);
  }
}

// ── Utility: safe cache put with size guard ─────────────────
async function safePut(cache, request, response) {
  if (request.method !== "GET") return;
  // Only cache successful responses
  if (!response || response.status !== 200) return;
  // Skip non-cacheable response types (opaque or error)
  if (response.type === "opaque") return;
  try {
    await cache.put(request, response.clone());
    await trimCache(cache);
  } catch (err) {
    // Cache storage full or other quota error — silently evict
    console.warn("[SW] Cache put failed, evicting:", err.message);
  }
}

// ── Utility: network-only helper that doesn't cache ────────
async function tryNetwork(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    return null;
  }
}

// ── Helper: match a request against a pattern list ─────────
function matchAny(url, patterns) {
  return patterns.some((p) => {
    if (p instanceof RegExp) return p.test(url);
    return url.startsWith(p);
  });
}

// ── Strategy patterns ───────────────────────────────────────
const STATIC_PATTERNS = [
  "/_next/static/",
  "/_next/image/",
  "/fonts.googleapis.com/",
  "/fonts.gstatic.com/",
  "/cdn.jsdelivr.net/",
];

const FONT_PATTERNS = [
  "/fonts.googleapis.com/",
  "/fonts.gstatic.com/",
];

const API_PATTERN = /^\/api\//;

function isStaticAsset(url) {
  // Images with common extensions
  if (/\.(js|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|gif|ico|avif)(\?.*)?$/i.test(url.pathname)) {
    return true;
  }
  return matchAny(url.href, STATIC_PATTERNS);
}

function isFontRequest(url) {
  return matchAny(url.href, FONT_PATTERNS);
}

function isApiRequest(url) {
  return API_PATTERN.test(url.pathname);
}

function isNavigationRequest(event) {
  return (
    event.request.mode === "navigate" ||
    (event.request.method === "GET" &&
      event.request.headers.get("accept")?.includes("text/html"))
  );
}

// ============================================================
//  INSTALL — Pre-cache critical app-shell assets
// ============================================================
self.addEventListener("install", (event) => {
  console.log("[SW] Installing razkindo-erp-v1");
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Add inline offline page first
      const offlineResponse = new Response(OFFLINE_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
      await cache.put(new Request("/offline.html"), offlineResponse);

      // Pre-cache app shell URLs (ignore failures for external URLs)
      const results = await Promise.allSettled(
        PRECACHE_URLS.map((url) => {
          const req = new Request(url, { cache: "reload" });
          return fetch(req).then((res) => {
            if (res.ok) return cache.put(req, res);
            return Promise.reject(new Error(`${url} → ${res.status}`));
          });
        })
      );

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        console.warn("[SW] Some precache URLs failed:", failed.map((f) => f.reason.message));
      }
    })
  );
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting();
});

// ============================================================
//  ACTIVATE — Clean up old caches
// ============================================================
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating razkindo-erp-v1");
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log("[SW] Deleting old cache:", name);
            return caches.delete(name);
          })
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ============================================================
//  FETCH — Route requests to appropriate caching strategy
// ============================================================
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip non-GET ──────────────────────────────────────────
  if (request.method !== "GET") return;

  // ── Skip chrome-extension / devtools ──────────────────────
  if (url.protocol === "chrome-extension:" || url.protocol === "devtools:") return;

  // ── 1. FONT REQUESTS → Cache-first (long TTL) ────────────
  if (isFontRequest(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── 2. STATIC ASSETS → Cache-first ───────────────────────
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── 3. API REQUESTS → Network-first ──────────────────────
  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ── 4. NAVIGATION / PAGE REQUESTS → Stale-while-revalidate
  if (isNavigationRequest(event)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── 5. EVERYTHING ELSE → Network-first with offline fallback
  event.respondWith(networkFirstWithOffline(request));
});

// ============================================================
//  Strategy: Cache-First
//  Use for: JS, CSS, fonts, images, any static asset
// ============================================================
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await safePut(cache, request, networkResponse);
    }
    return networkResponse;
  } catch {
    // For images, return a transparent 1×1 placeholder
    if (
      /\.(png|jpg|jpeg|webp|gif|svg|ico|avif)(\?.*)?$/i.test(request.url)
    ) {
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        { headers: { "Content-Type": "image/svg+xml" } }
      );
    }
    return new Response("", { status: 503, statusText: "Offline" });
  }
}

// ============================================================
//  Strategy: Network-First
//  Use for: /api/ calls — always try fresh data, fallback cache
// ============================================================
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await safePut(cache, request, networkResponse);
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({ error: true, message: "Offline — no cached data available" }),
      {
        status: 503,
        statusText: "Offline",
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// ============================================================
//  Strategy: Stale-While-Revalidate
//  Use for: page navigations — instant cached + background refresh
// ============================================================
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Background fetch + cache update (fire-and-forget)
  const backgroundFetch = fetch(request)
    .then((networkResponse) => {
      if (networkResponse.ok) {
        safePut(cache, request, networkResponse);
      }
      return networkResponse;
    })
    .catch(() => null);

  // Return cached immediately if available, else wait for network
  if (cached) {
    // Don't await — let the background fetch happen independently
    backgroundFetch.then((freshResponse) => {
      if (freshResponse && freshResponse.ok) {
        // Notify all clients about the update so they can refresh
        self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({
              type: "SW_PAGE_UPDATED",
              url: request.url,
            });
          });
        });
      }
    });
    return cached;
  }

  try {
    const networkResponse = await backgroundFetch;
    if (networkResponse) {
      return networkResponse;
    }
    throw new Error("No response");
  } catch {
    // Show offline fallback for navigation requests
    const offlinePage = await cache.match("/offline.html");
    if (offlinePage) return offlinePage;

    return new Response(OFFLINE_HTML, {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }
}

// ============================================================
//  Strategy: Network-First with Offline Fallback
//  Use for: everything else
// ============================================================
async function networkFirstWithOffline(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await safePut(cache, request, networkResponse);
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // For HTML-like requests, serve offline page
    const accept = request.headers.get("accept") || "";
    if (accept.includes("text/html")) {
      const offlinePage = await cache.match("/offline.html");
      if (offlinePage) return offlinePage;
      return new Response(OFFLINE_HTML, {
        status: 503,
        statusText: "Offline",
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    return new Response("", { status: 503, statusText: "Offline" });
  }
}

// ============================================================
//  MESSAGE HANDLER — Accept dynamic cache updates from app
// ============================================================
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data && event.data.type === "CACHE_URLS") {
    const urls = event.data.payload;
    if (Array.isArray(urls)) {
      event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
          Promise.allSettled(
            urls.map((url) => {
              const req = new Request(url, { cache: "reload" });
              return fetch(req).then((res) => {
                if (res.ok) return cache.put(req, res);
              });
            })
          )
        )
      );
    }
  }
});
