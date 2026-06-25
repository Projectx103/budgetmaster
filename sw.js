// ════════════════════════════════════════════════════════════════════════════
// sw.js — BudgetMaster Service Worker
//
// Strategy: NETWORK-FIRST for the static app shell, BYPASS for everything else.
//
// Why network-first:
//   - Always serves fresh code when online — users get bug fixes on next launch.
//   - Falls back to cached shell when offline — app still loads on the airplane.
//   - Avoids the classic "PWA cache hell" where users get stuck on stale HTML.
//
// What we intentionally do NOT cache or intercept:
//   - firestore.googleapis.com (Firestore handles its own IndexedDB persistence)
//   - firebaseauth.googleapis.com / identitytoolkit (auth tokens)
//   - fonts.googleapis.com / fonts.gstatic.com (browser handles these well already)
//   - cdn.jsdelivr.net (Firebase SDK + Chart.js CDN)
//   - Anything cross-origin we don't explicitly own
//
// Version bumping:
//   - Change CACHE_NAME ("v1" → "v2") whenever you ship a breaking shell change.
//   - The activate event auto-purges any old cache name that doesn't match.
//
// NO skipWaiting() — users get the new version on next app relaunch, not
// mid-session. This is the safe default for a fintech app.
// ════════════════════════════════════════════════════════════════════════════

const CACHE_NAME = "budgetmaster-shell-v1";

// Core shell assets — listed by relative path so this works regardless of
// where the repo is deployed (root vs. subpath like /budgetmaster/).
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./auth.html",
  "./help.html",
  "./sign_auth.html",
  "./style.css",
  "./script.js",
  "./auth-page.js",
  "./manifest.json",
  "./BUDGETMASTER_LOGO.svg",
  "./firebase/firebaseConfig.js",
  "./firebase/authService.js",
  "./helpers/currency.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

// ── INSTALL: pre-cache the shell so first offline visit works ───────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fails atomically if ANY file 404s. Use individual adds with
      // catch so a missing optional file doesn't block install entirely.
      return Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[SW] Pre-cache skipped (not found):", url, err.message);
          })
        )
      );
    })
  );
  // Do NOT call self.skipWaiting() — wait for next launch.
});

// ── ACTIVATE: purge old cache versions ─────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((stale) => {
            console.log("[SW] Purging stale cache:", stale);
            return caches.delete(stale);
          })
      )
    )
  );
});

// ── FETCH: network-first for shell, bypass everything else ─────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Bypass non-GET requests entirely (POSTs to Firestore, etc.)
  if (req.method !== "GET") return;

  // 2. Bypass cross-origin requests — Firebase, CDNs, Google Fonts.
  //    The browser already handles caching these efficiently, and we
  //    must never intercept Firestore live data.
  if (url.origin !== self.location.origin) return;

  // 3. Bypass Firestore-internal endpoints even if served same-origin
  //    (paranoid: Firebase's offline persistence handles its own state).
  if (
    url.pathname.includes("/firestore.googleapis.com") ||
    url.pathname.includes("/identitytoolkit.googleapis.com") ||
    url.pathname.includes("/firebaseauth")
  ) {
    return;
  }

  // 4. Same-origin shell asset → network-first with cache fallback.
  event.respondWith(
    fetch(req)
      .then((response) => {
        // Only cache successful, basic responses (not redirects or errors)
        if (
          response &&
          response.status === 200 &&
          response.type === "basic"
        ) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(req, clone))
            .catch(() => { /* cache full or unavailable — ignore */ });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try the cache
        return caches.match(req).then((cached) => {
          if (cached) return cached;

          // Last-resort fallback for navigations: serve cached index.html
          // so the SPA can boot and show "offline" UI if needed.
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }

          // Otherwise let the failure propagate — the page will see it.
          return new Response("", { status: 503, statusText: "Offline" });
        });
      })
  );
});
