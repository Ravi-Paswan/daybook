// Hash router (spec 3.4).  Routes look like  #/<id>/<param1>/<param2>?a=b
//
//   route = { id, params: string[], query: Object, path }
//   - path   = '/' + raw segments (as they appear in the URL, no query) — e.g. '/trades/plan/2026-11-24'.
//              navigate(route.path) round-trips.
//   - params = decoded segments after the id.
//   - query  = plain object from the query string (last value wins for repeated keys).
//   Unknown or empty ids fall back to '/today' (the history entry is replaced so Back doesn't loop).
//
// Notes (choices the spec leaves open):
//   - navigate() to the hash that is already current re-runs the route handler (fresh render) instead of
//     being a no-op — handy for "refresh this page" and for nav items tapped twice.
//   - navigate(path, { replace: true }) swaps the history entry and routes immediately.
//   - navigate(path, { silent: true }) only rewrites the URL (replaceState) without rendering — for modules that
//     want to drop a one-shot query such as '?new=1' without re-rendering themselves.

import { moduleIds } from '../modules/registry.js';

const DEFAULT_PATH = '/today';

let handler = null;
let listening = false;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isKnown(id) {
  try {
    const ids = moduleIds();
    return !Array.isArray(ids) || ids.length === 0 || ids.includes(id);
  } catch {
    return true;
  }
}

/** Parse a hash string ('#/food/x?a=b', '/food', 'food') into a route object (no validation). */
export function parseHash(hash) {
  let raw = String(hash == null ? '' : hash).trim();
  if (raw.startsWith('#')) raw = raw.slice(1);
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const queryPart = qi >= 0 ? raw.slice(qi + 1) : '';
  const segments = pathPart.split('/').filter(Boolean);
  const query = {};
  if (queryPart) {
    try {
      for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
    } catch {
      /* ignore a malformed query */
    }
  }
  return {
    id: segments.length ? safeDecode(segments[0]) : '',
    params: segments.slice(1).map(safeDecode),
    query,
    path: '/' + segments.join('/'),
  };
}

function defaultRoute() {
  return parseHash(DEFAULT_PATH);
}

/** → { id, params, query, path } for the current location (unknown/empty → /today). */
export function currentRoute() {
  const r = parseHash(location.hash);
  if (!r.id || !isKnown(r.id)) return defaultRoute();
  return r;
}

function toHash(path) {
  let p = String(path == null ? '' : path).trim();
  if (p.startsWith('#')) p = p.slice(1);
  if (!p.startsWith('/')) p = '/' + p;
  return '#' + p;
}

function sameHash(a, b) {
  if (a === b) return true;
  try {
    return decodeURI(a) === decodeURI(b);
  } catch {
    return false;
  }
}

function dispatch() {
  const parsed = parseHash(location.hash);
  let route = parsed;
  if (!parsed.id || !isKnown(parsed.id)) {
    route = defaultRoute();
    try {
      history.replaceState(history.state, '', '#' + route.path);
    } catch {
      /* file:// or sandboxed — ignore */
    }
  }
  if (!handler) return;
  try {
    const res = handler(route);
    if (res && typeof res.catch === 'function') {
      res.catch((err) => console.error('[daybook] route handler failed:', err));
    }
  } catch (err) {
    console.error('[daybook] route handler failed:', err);
  }
}

/** Calls onRoute(route) now and on every hashchange. Returns a stop() function. */
export function startRouter(onRoute) {
  handler = onRoute;
  if (!listening) {
    window.addEventListener('hashchange', dispatch);
    listening = true;
  }
  dispatch();
  return () => {
    window.removeEventListener('hashchange', dispatch);
    listening = false;
    handler = null;
  };
}

/** navigate('/food') | navigate('#/food') | navigate('/trades/view/abc') | navigate('/search?q=dal') */
export function navigate(path, { replace = false, silent = false } = {}) {
  const hash = toHash(path);
  if (silent) {
    try {
      history.replaceState(history.state, '', hash);
    } catch {
      /* ignore */
    }
    return;
  }
  if (sameHash(location.hash, hash)) {
    dispatch();
    return;
  }
  if (replace) {
    try {
      history.replaceState(history.state, '', hash);
      dispatch();
      return;
    } catch {
      /* fall through to a normal hash change */
    }
  }
  location.hash = hash;
}
