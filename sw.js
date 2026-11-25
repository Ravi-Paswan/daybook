/* Daybook service worker: offline app shell + fast repeat loads.
 *
 *   install   Precache the app shell. One fetch + cache.put per URL, each inside try/catch, so a single
 *             missing or failing file never breaks the install (it is picked up later by the runtime cache).
 *   navigate  Network-first, so you always get the latest index.html when online. Falls back to the cached
 *             shell when offline, on a server error, or when the network is slower than NAV_TIMEOUT_MS
 *             (the fresh copy still updates the cache in the background).
 *   assets    Same-origin GET: stale-while-revalidate (served instantly from cache, refreshed in background).
 *   ignored   Non-GET, cross-origin, Range requests, sw.js itself, and everything under tools/ or docs/.
 *   activate  Deletes every other 'daybook-*' cache and takes control of open pages (clients.claim()).
 *   update    A new worker WAITS. The page shows "Update ready" and posts {type: 'SKIP_WAITING'} on Reload.
 *             No automatic skipWaiting, so a running session never mixes old and new files.
 *
 * Messages:  {type:'SKIP_WAITING'}  activate the waiting worker now.
 *            {type:'GET_VERSION'}   replies {type:'VERSION', version, cache} (via MessagePort if given).
 *
 * Shipping a new version: bump VERSION. Any byte change to this file makes browsers install the new
 * worker, which precaches fresh copies (bypassing the HTTP cache) and then waits for "Reload".
 * All paths are relative to this file, so the app works from a sub-folder (e.g. GitHub Pages).
 */

const VERSION = '2';
const CACHE = `daybook-v${VERSION}`;
const NAV_TIMEOUT_MS = 4000;

// App shell: every file named in docs/SPEC.md section 1 that the browser needs at runtime.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',

  'css/tokens.css',
  'css/base.css',
  'css/components.css',
  'css/charts.css',
  'css/modules/today.css',
  'css/modules/food.css',
  'css/modules/learning.css',
  'css/modules/training.css',
  'css/modules/expenses.css',
  'css/modules/trades.css',
  'css/modules/trades-analytics.css',
  'css/modules/goals.css',
  'css/modules/calendar.css',
  'css/modules/insights.css',
  'css/modules/search.css',
  'css/modules/settings.css',
  'css/modules/onboarding.css',

  'js/app.js',
  'js/core/db.js',
  'js/core/bus.js',
  'js/core/settings.js',
  'js/core/router.js',
  'js/core/ui.js',
  'js/core/undo.js',
  'js/core/dates.js',
  'js/core/format.js',
  'js/core/charts.js',
  'js/core/icons.js',
  'js/core/metrics.js',
  'js/core/images.js',
  'js/core/backup.js',
  'js/core/sync.js',
  'js/core/sync-config.js',

  'js/modules/registry.js',
  'js/modules/today.js',
  'js/modules/food.js',
  'js/modules/learning.js',
  'js/modules/training.js',
  'js/modules/expenses.js',
  'js/modules/trades/index.js',
  'js/modules/trades/calc.js',
  'js/modules/trades/editor.js',
  'js/modules/trades/detail.js',
  'js/modules/trades/analytics.js',
  'js/modules/trades/calendar.js',
  'js/modules/trades/dayplan.js',
  'js/modules/goals.js',
  'js/modules/calendar.js',
  'js/modules/insights.js',
  'js/modules/search.js',
  'js/modules/settings-view.js',
  'js/modules/onboarding.js',
  'js/modules/sample-data.js',

  'assets/icons/icon.svg',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'assets/icons/apple-touch-icon.png',
];

const BASE = new URL('./', self.location.href); // the folder that holds sw.js = app root
const ROOT_URL = BASE.href;
const INDEX_URL = new URL('index.html', BASE).href;
const NEVER_CACHE = ['tools/', 'docs/'];
const MATCH = { ignoreVary: true };

// ------------------------------------------------------------------------------------------- lifecycle

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('daybook-') && name !== CACHE)
      .map((name) => caches.delete(name)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) { /* unsupported: fine */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'GET_VERSION') {
    reply(event, { type: 'VERSION', version: VERSION, cache: CACHE });
  }
});

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (path) => {
    const url = new URL(path, BASE).href;
    try {
      // cache:'reload' skips the HTTP cache so a new version never precaches stale files.
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (res.ok) await cache.put(url, await withoutRedirect(res));
    } catch (_) {
      // Offline or not deployed yet: stale-while-revalidate will cache it on first use.
    }
  }));
}

// ----------------------------------------------------------------------------------------------- fetch

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE.pathname)) return; // outside the app folder

  const rel = url.pathname.slice(BASE.pathname.length);
  if (rel === 'sw.js' || NEVER_CACHE.some((prefix) => rel.startsWith(prefix))) {
    // Never cached. Navigations still consume the navigation-preload response (no double request).
    if (req.mode === 'navigate') event.respondWith(preloadOrFetch(event));
    return;
  }
  if (req.headers.has('range')) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event, rel));
  } else if (req.cache === 'no-store' || req.cache === 'reload') {
    event.respondWith(networkThenCache(req));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

async function handleNavigation(event, rel) {
  const cache = await caches.open(CACHE);
  const isShell = rel === '' || rel === 'index.html';

  const fromNetwork = (async () => {
    const res = await preloadOrFetch(event);
    if (res && res.ok && isShell) {
      // Keep the offline copy of the shell fresh (stored under both './' and 'index.html').
      event.waitUntil(saveShell(cache, res.clone()).catch(() => {}));
    }
    return res;
  })();
  fromNetwork.catch(() => {}); // handled below; avoids an "unhandled rejection" while we check the cache

  const cached = await matchShell(cache, event.request);
  if (!cached) {
    try {
      return await fromNetwork;
    } catch (_) {
      return offlinePage();
    }
  }

  // A cached shell exists: prefer the network, but never leave the user staring at a blank screen.
  event.waitUntil(fromNetwork.catch(() => {}));
  try {
    const res = await withTimeout(fromNetwork, NAV_TIMEOUT_MS);
    return res.status >= 500 ? cached : res;
  } catch (_) {
    return cached;
  }
}

async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, MATCH);

  const refresh = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    }
    return res;
  });

  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  try {
    return await refresh;
  } catch (err) {
    const loose = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (loose) return loose;
    throw err; // same network error the page would get without a service worker
  }
}

async function networkThenCache(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, MATCH);
    if (cached) return cached;
    throw err;
  }
}

// --------------------------------------------------------------------------------------------- helpers

async function preloadOrFetch(event) {
  let res;
  try { res = await event.preloadResponse; } catch (_) { res = undefined; }
  return res || fetch(event.request);
}

async function matchShell(cache, request) {
  return (await cache.match(request, { ignoreSearch: true, ignoreVary: true }))
    || (await cache.match(INDEX_URL, MATCH))
    || (await cache.match(ROOT_URL, MATCH));
}

async function saveShell(cache, res) {
  const clean = await withoutRedirect(res);
  const body = await clean.blob();
  const init = { status: clean.status, statusText: clean.statusText, headers: clean.headers };
  await Promise.all([
    cache.put(INDEX_URL, new Response(body, init)),
    cache.put(ROOT_URL, new Response(body, init)),
  ]);
}

// Browsers refuse to use a redirected response for a navigation, so store a clean copy instead
// (e.g. hosts that redirect /index.html -> /).
async function withoutRedirect(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function reply(event, data) {
  if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
  else if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(data);
}

// Shown only when the app has never been loaded online on this device (nothing cached yet).
function offlinePage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#4f46e5">
<title>Offline · Daybook</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #111827; --muted: #6b7280; --border: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0d12; --card: #151821; --text: #f3f4f6; --muted: #9ca3af; --border: #262a36; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg);
         color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 380px; width: 100%; text-align: center; background: var(--card); border: 1px solid var(--border);
         border-radius: 24px; padding: 32px 24px; box-shadow: 0 10px 30px rgba(17, 24, 39, .08); }
  svg { width: 72px; height: 72px; border-radius: 18px; }
  h1 { font-size: 22px; margin: 16px 0 8px; }
  p { color: var(--muted); margin: 0 0 24px; }
  button { font: inherit; font-weight: 600; color: #fff; background: #4f46e5; border: 0; border-radius: 999px;
           min-height: 44px; padding: 0 24px; cursor: pointer; }
  button:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 512 512" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="512" height="512" rx="115" fill="url(#g)"/><g fill="#fff"><path d="M176 250a80 80 0 0 1 160 0z"/><rect x="112" y="273" width="288" height="34" rx="17"/><rect x="112" y="332" width="218" height="28" rx="14" opacity=".8"/><rect x="112" y="384" width="138" height="28" rx="14" opacity=".55"/></g><g stroke="#fff" stroke-width="30" stroke-linecap="round"><path d="M256 144v-44M334.8 179.1l32.7-29.5M177.2 179.1l-32.7-29.5"/></g></svg>
  <h1>You're offline</h1>
  <p>Daybook needs one visit with an internet connection before it works offline. Check your connection and try again.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
