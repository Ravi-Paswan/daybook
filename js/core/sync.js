// Cloud sync (Supabase) — accounts + multi-device sync for the on-device IndexedDB data.
//
// Design (offline-first, state-based):
// - IndexedDB stays the source of truth for the UI. Every device keeps a full copy and works offline.
// - Remote: one table `records` (supabase/schema.sql): (user_id, store, key) → data jsonb | tombstone, with a
//   server-assigned increasing `rev`. A device pulls "rev > cursor" and pushes what changed locally.
// - Change detection needs no hooks into the rest of the app: a separate IndexedDB ('daybook-sync') keeps a
//   "shadow" fingerprint of every record as last synced. Push = every local record whose fingerprint differs
//   from its shadow (+ tombstones for shadows whose record is gone). So imports, sample data, restores… all sync.
// - Conflicts (the same record changed on two devices between syncs): newest updatedAt wins. On a device's very
//   first sync, the cloud's settings win over the fresh device's onboarding defaults.
// - Safety: if one sync would delete many records everywhere, deletions pause until the user confirms.
// - Photos (files store) travel as base64 inside the JSON row.
// - Live updates via Supabase Realtime (websocket) + polling fallback (focus / online / every minute).
// - Auth: email + password via the Supabase Auth REST API (no SDK, no build step). Session in localStorage
//   'daybook.sync.session' — "Delete everything" wipes daybook* keys, which signs this device out on purpose
//   (it erases this device only; the cloud copy stays).
//
// Events: emits 'sync:status' (getStatus()) on every change; applied remote changes emit
// 'db:change' {store:'*', op:'sync', stores} and, when settings changed, 'settings:change'.

import { STORES, keyPathOf, runTransaction, isPlainObject } from './db.js';
import { emit, on } from './bus.js';
import { loadSettings } from './settings.js';
import { SYNC_URL as CFG_URL, SYNC_KEY } from './sync-config.js';

const SESSION_KEY = 'daybook.sync.session';
const DEV_URL_KEY = 'daybookdev.syncUrl'; // localhost-only override for tests
const SYNC_DB = 'daybook-sync';
const PAGE = 100; // rows per pull request
const MAX_BATCH_BYTES = 900 * 1024; // per push request
const MAX_BATCH_ROWS = 200;
const POLL_MS = 60 * 1000;
const MASS_DELETE_MIN = 25;
const MASS_DELETE_SHARE = 0.2;
const SEP = '\u0001';

function isLocalHost() {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  } catch {
    return false;
  }
}

const BASE_URL = (() => {
  try {
    const dev = isLocalHost() ? localStorage.getItem(DEV_URL_KEY) : null;
    return String(dev || CFG_URL || '').replace(/\/+$/, '');
  } catch {
    return String(CFG_URL || '').replace(/\/+$/, '');
  }
})();

// ------------------------------------------------------------------------------------------------ status

let session = null; // {access_token, refresh_token, expires_at, user:{id,email}}
const status = {
  configured: !!(BASE_URL && SYNC_KEY),
  signedIn: false,
  email: null,
  phase: 'idle', // idle | syncing | offline | error
  error: null,
  lastSyncAt: null,
  pending: 0,
  firstDone: false,
  massDelete: null, // {count} → waiting for the user's decision
  recovery: false, // signed in through a password-reset link → offer "set a new password"
  notice: null,
};

export function isConfigured() {
  return status.configured;
}

export function getStatus() {
  return { ...status, massDelete: status.massDelete ? { ...status.massDelete } : null };
}

function setStatus(patch) {
  Object.assign(status, patch);
  emit('sync:status', getStatus());
}

// ------------------------------------------------------------------------------------------- sync db

let syncDbP = null;
function syncDb() {
  if (!syncDbP) {
    syncDbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(SYNC_DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('shadow')) d.createObjectStore('shadow', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'k' });
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close();
          syncDbP = null;
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Sync storage is blocked by another tab'));
    });
    syncDbP.catch(() => {
      syncDbP = null;
    });
  }
  return syncDbP;
}

async function sdb(stores, mode, body) {
  const d = await syncDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let out;
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Sync storage transaction aborted'));
    out = body(tx);
  });
}

async function getState() {
  const rows = await sdb('state', 'readonly', (tx) => {
    const r = tx.objectStore('state').getAll();
    return () => r.result || [];
  });
  const s = {};
  for (const row of rows) s[row.k] = row.v;
  return s;
}

async function setState(patch) {
  await sdb('state', 'readwrite', (tx) => {
    const os = tx.objectStore('state');
    for (const [k, v] of Object.entries(patch)) os.put({ k, v });
  });
}

async function allShadows() {
  const rows = await sdb('shadow', 'readonly', (tx) => {
    const r = tx.objectStore('shadow').getAll();
    return () => r.result || [];
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function writeShadows(puts, dels) {
  if (!puts.length && !dels.length) return;
  await sdb('shadow', 'readwrite', (tx) => {
    const os = tx.objectStore('shadow');
    for (const p of puts) os.put(p);
    for (const id of dels) os.delete(id);
  });
}

async function resetSyncDb() {
  try {
    await sdb(['shadow', 'state'], 'readwrite', (tx) => {
      tx.objectStore('shadow').clear();
      tx.objectStore('state').clear();
    });
  } catch (err) {
    console.warn('[daybook] could not reset sync state', err);
  }
}

// ----------------------------------------------------------------------------------------- fingerprints

function replacer(_k, v) {
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { $blob: v.size, type: v.type || '' };
  if (isPlainObject(v)) {
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = v[key];
    return out;
  }
  return v;
}

/** Stable fingerprint of a record (key order independent, JSON semantics — same as the round trip via jsonb). */
export function fingerprint(rec) {
  if (rec === undefined || rec === null) return null;
  const s = JSON.stringify(rec, replacer) || '';
  // cyrb53
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + ':' + s.length;
}

const sid = (store, key) => `${store}${SEP}${key}`;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

async function encodeRecord(store, rec) {
  if (store === 'files' && rec && typeof Blob !== 'undefined' && rec.blob instanceof Blob) {
    const out = { ...rec };
    delete out.blob;
    out.$blob64 = await blobToBase64(rec.blob);
    out.$blobType = rec.blob.type || rec.type || '';
    return out;
  }
  return rec;
}

function decodeRecord(store, data) {
  if (!isPlainObject(data)) return null;
  if (store === 'files' && typeof data.$blob64 === 'string') {
    const out = { ...data };
    out.blob = base64ToBlob(data.$blob64, data.$blobType || data.type);
    delete out.$blob64;
    delete out.$blobType;
    return out;
  }
  return data;
}

const tsMs = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
};

// -------------------------------------------------------------------------------------------- http

class SyncError extends Error {
  constructor(message, { status = 0, code = '', offline = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.offline = offline;
  }
}

const FRIENDLY = [
  [/invalid login credentials/i, 'Wrong email or password.'],
  [/email not confirmed/i, 'Confirm your email first — open the link we sent you, then sign in.'],
  [/already (been )?registered|user_already_exists|already exists/i, 'An account with this email already exists — sign in instead.'],
  [/password should be at least|weak_password|password is too weak/i, 'Choose a stronger password (at least 8 characters, mixing letters and numbers).'],
  [/rate limit|too many|over_email_send_rate_limit|429/i, 'Too many attempts right now. Wait a few minutes and try again.'],
  [/unable to validate email|invalid email|email_address_invalid/i, 'That email address doesn’t look right.'],
  [/relation .*records.* does not exist|PGRST205|Could not find the table/i, 'The cloud database isn’t set up yet (run supabase/schema.sql in Supabase).'],
  [/signups? not allowed|signup_disabled/i, 'New accounts are switched off for this Daybook.'],
];

function friendly(json, statusCode) {
  const raw = json ? json.msg || json.error_description || json.message || json.error || json.code || '' : '';
  const hay = `${raw} ${json && (json.error_code || json.code) ? json.error_code || json.code : ''} ${statusCode}`;
  for (const [re, msg] of FRIENDLY) if (re.test(hay)) return msg;
  return raw ? String(raw) : `Server error (${statusCode})`;
}

async function http(path, { method = 'GET', body, headers = {}, auth = true, retry = true } = {}) {
  if (!status.configured) throw new SyncError('Sync isn’t configured');
  const h = { apikey: SYNC_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth) {
    const s = await validSession();
    if (!s) throw new SyncError('Signed out', { status: 401, code: 'signed_out' });
    h.Authorization = `Bearer ${s.access_token}`;
  }
  let res;
  try {
    res = await fetch(BASE_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new SyncError('You’re offline', { offline: true });
  }
  if (res.status === 401 && auth && retry) {
    await refreshSession(true);
    return http(path, { method, body, headers, auth, retry: false });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new SyncError(friendly(json, res.status), { status: res.status, code: (json && (json.error_code || json.code)) || '' });
  return json;
}

// -------------------------------------------------------------------------------------------- session

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.access_token && s.refresh_token && s.user && s.user.id ? s : null;
  } catch {
    return null;
  }
}

function storeSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked — session lives in memory for this visit */
  }
}

function sessionFromToken(json) {
  if (!json || !json.access_token) return null;
  const expiresAt = json.expires_at || Math.floor(Date.now() / 1000) + (Number(json.expires_in) || 3600);
  const user = json.user || {};
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: expiresAt,
    user: { id: user.id, email: user.email || null },
  };
}

let refreshing = null;
async function refreshSession(force = false) {
  if (!session) return null;
  if (!force && session.expires_at * 1000 - Date.now() > 60 * 1000) return session;
  if (refreshing) return refreshing;
  const rt = session.refresh_token;
  refreshing = (async () => {
    try {
      // Another tab may have refreshed already.
      const stored = readStoredSession();
      if (stored && stored.refresh_token !== rt && stored.user.id === session.user.id && stored.expires_at * 1000 - Date.now() > 60 * 1000) {
        session = stored;
        return session;
      }
      const json = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt }, auth: false });
      const next = sessionFromToken(json);
      if (!next || !next.user.id) throw new SyncError('Session refresh failed', { status: 400 });
      storeSession(next);
      realtimeToken();
      return next;
    } catch (err) {
      if (err instanceof SyncError && !err.offline && err.status >= 400 && err.status < 500) {
        await endSession('Your sign-in expired. Please sign in again.');
        return null;
      }
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function validSession() {
  if (!session) return null;
  return refreshSession(false);
}

async function adoptSession(next, { recovery = false } = {}) {
  const st = await getState().catch(() => ({}));
  if (st.userId && st.userId !== next.user.id) await resetSyncDb(); // a different account → start clean
  storeSession(next);
  await setState({ userId: next.user.id });
  const fresh = await getState().catch(() => ({}));
  setStatus({ signedIn: true, email: next.user.email, error: null, phase: 'idle', recovery, firstDone: !!fresh.firstDone, massDelete: null, notice: null });
  startLoops();
  requestSync(0);
}

/** Local sign-out: forget the session and sync bookkeeping; this device keeps its data. */
async function endSession(reason) {
  storeSession(null);
  stopLoops();
  await resetSyncDb();
  setStatus({ signedIn: false, email: null, phase: 'idle', error: reason || null, lastSyncAt: null, pending: 0, firstDone: false, massDelete: null, recovery: false });
}

// -------------------------------------------------------------------------------------------- auth API

export async function signIn(email, password) {
  const json = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: String(email).trim(), password }, auth: false });
  const s = sessionFromToken(json);
  if (!s || !s.user.id) throw new SyncError('Sign-in failed. Please try again.');
  await adoptSession(s);
  return getStatus();
}

function redirectTarget() {
  try {
    return location.origin + location.pathname;
  } catch {
    return '';
  }
}

/** → {confirmEmail: true} when the project requires email confirmation, else signs in. */
export async function signUp(email, password) {
  const to = redirectTarget();
  const q = to ? `?redirect_to=${encodeURIComponent(to)}` : '';
  const json = await http(`/auth/v1/signup${q}`, { method: 'POST', body: { email: String(email).trim(), password }, auth: false });
  const s = sessionFromToken(json);
  if (s && s.user.id) {
    await adoptSession(s);
    return { confirmEmail: false };
  }
  return { confirmEmail: true };
}

export async function sendPasswordReset(email) {
  const to = redirectTarget();
  const q = to ? `?redirect_to=${encodeURIComponent(to)}` : '';
  await http(`/auth/v1/recover${q}`, { method: 'POST', body: { email: String(email).trim() }, auth: false });
}

export async function setNewPassword(password) {
  await http('/auth/v1/user', { method: 'PUT', body: { password } });
  setStatus({ recovery: false, notice: 'Password updated.' });
}

export async function signOut() {
  const s = session;
  if (s) {
    try {
      await fetch(BASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SYNC_KEY, Authorization: `Bearer ${s.access_token}` } });
    } catch {
      /* offline — the token simply expires */
    }
  }
  await endSession(null);
}

/**
 * Call once at boot BEFORE the router starts. Handles the redirect back from an email link
 * (#access_token=…&type=signup|recovery|magiclink or #error=…). → {type, error} | null
 */
export async function handleAuthRedirect() {
  if (!status.configured) return null;
  const hash = String(location.hash || '');
  if (!/^#(access_token|error)=|[#&](access_token|error_description)=/.test(hash) || hash.startsWith('#/')) return null;
  const p = new URLSearchParams(hash.slice(1));
  const clean = (path) => {
    try {
      history.replaceState(null, '', location.pathname + location.search + path);
    } catch {
      location.hash = path;
    }
  };
  if (p.get('error') || p.get('error_description')) {
    clean('#/settings/sync');
    const msg = /expired|invalid/i.test(p.get('error_description') || '') ? 'That email link has expired or was already used. Sign in, or request a new link.' : p.get('error_description') || 'That link didn’t work.';
    setStatus({ error: msg });
    return { type: 'error', error: msg };
  }
  const token = p.get('access_token');
  const type = p.get('type') || 'signup';
  clean('#/settings/sync');
  try {
    const user = await (await fetch(BASE_URL + '/auth/v1/user', { headers: { apikey: SYNC_KEY, Authorization: `Bearer ${token}` } })).json();
    if (!user || !user.id) throw new Error('no user');
    const s = sessionFromToken({
      access_token: token,
      refresh_token: p.get('refresh_token'),
      expires_at: Number(p.get('expires_at')) || undefined,
      expires_in: Number(p.get('expires_in')) || 3600,
      user,
    });
    await adoptSession(s, { recovery: type === 'recovery' });
    setStatus({ notice: type === 'recovery' ? null : 'Email confirmed — you’re signed in and syncing.' });
    return { type };
  } catch {
    setStatus({ error: 'Couldn’t finish signing in from that link. Please sign in with your email and password.' });
    return { type: 'error' };
  }
}

// -------------------------------------------------------------------------------------------- sync core

let running = null;
let again = false;
let timer = 0;
let retryMs = 0;
let massDeleteApproved = false;

/** Debounced sync request. */
export function requestSync(delay = 1500) {
  if (!session) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    runSync();
  }, delay);
}

export function syncNow() {
  clearTimeout(timer);
  return runSync();
}

async function runSync() {
  if (!session) return;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again && session);
  })().finally(() => {
    running = null;
  });
  return running;
}

function sessionStillStored() {
  try {
    return !!localStorage.getItem(SESSION_KEY);
  } catch {
    return true; // storage blocked → memory-only session
  }
}

async function syncOnce() {
  if (!session) return;
  if (!sessionStillStored()) {
    // "Delete everything" wiped this device (and its sign-in). Never turn that into deletions in the cloud.
    await endSession(null);
    return;
  }
  setStatus({ phase: 'syncing' });
  try {
    const st = await getState();
    const first = !st.firstDone;
    await pull(st.cursor || 0, first);
    await push();
    if (first) await setState({ firstDone: true });
    retryMs = 0;
    setStatus({ phase: 'idle', error: null, lastSyncAt: new Date().toISOString(), firstDone: true });
  } catch (err) {
    if (!session) return;
    const offline = err && err.offline;
    if (!offline) console.warn('[daybook] sync failed', err);
    retryMs = Math.min(retryMs ? retryMs * 2 : 5000, 5 * 60 * 1000);
    setStatus({ phase: offline ? 'offline' : 'error', error: offline ? null : (err && err.message) || 'Sync failed' });
    requestSync(retryMs);
  }
}

async function pull(cursor, first) {
  let cur = cursor;
  for (;;) {
    const rows = await http(`/rest/v1/records?select=store,key,data,deleted,rev,client_ts&rev=gt.${cur}&order=rev.asc&limit=${PAGE}`);
    if (!Array.isArray(rows) || !rows.length) break;
    await applyRemote(rows, first);
    cur = Math.max(cur, ...rows.map((r) => Number(r.rev) || 0));
    await setState({ cursor: cur });
    if (rows.length < PAGE) break;
  }
}

async function applyRemote(rows, first) {
  const items = [];
  for (const row of rows) {
    if (!STORES.includes(row.store) || row.key === undefined || row.key === null) continue;
    let rec = null;
    if (!row.deleted) {
      try {
        rec = decodeRecord(row.store, row.data);
      } catch (err) {
        console.warn('[daybook] skipped an unreadable synced record', row.store, row.key, err);
        continue;
      }
      if (!rec) continue;
      const kp = keyPathOf(row.store);
      if (rec[kp] === undefined) rec[kp] = row.key;
    }
    items.push({ store: row.store, key: row.key, rec, ts: tsMs(row.client_ts) });
  }
  if (!items.length) return;

  const shadows = await allShadows();
  const stores = [...new Set(items.map((i) => i.store))];
  const shadowPuts = [];
  const shadowDels = [];
  const changedStores = new Set();

  await runTransaction(stores, 'readwrite', (tx, abortWith) => {
    for (const it of items) {
      const os = tx.objectStore(it.store);
      const g = os.get(it.key);
      g.onsuccess = () => {
        try {
          const local = g.result;
          const id = sid(it.store, it.key);
          const lh = fingerprint(local);
          const rh = fingerprint(it.rec);
          const sh = shadows.get(id);
          if (lh === rh) {
            if (rh) shadowPuts.push({ id, s: it.store, k: it.key, h: rh });
            else if (sh) shadowDels.push(id);
            return;
          }
          const dirty = lh !== (sh ? sh.h : null);
          let takeRemote = !dirty;
          if (dirty) {
            if (it.store === 'meta' && first) takeRemote = true; // the account's settings beat a fresh device's defaults
            else if (!local) takeRemote = true; // deleted here, changed elsewhere → keep the data
            else takeRemote = it.ts > tsMs(local.updatedAt);
          }
          if (!takeRemote) return; // local stays dirty → pushed next
          if (it.rec) os.put(it.rec);
          else os.delete(it.key);
          changedStores.add(it.store);
          if (rh) shadowPuts.push({ id, s: it.store, k: it.key, h: rh });
          else shadowDels.push(id);
        } catch (err) {
          abortWith(err);
        }
      };
    }
  });
  await writeShadows(shadowPuts, shadowDels);

  if (changedStores.size) {
    if (changedStores.has('meta')) {
      try {
        const settings = await loadSettings();
        emit('settings:change', { settings, patch: settings, source: 'sync' });
      } catch (err) {
        console.warn('[daybook] could not reload synced settings', err);
      }
    }
    emit('db:change', { store: '*', op: 'sync', key: null, record: null, stores: [...changedStores] });
  }
}

async function push() {
  const uidv = session && session.user.id;
  if (!uidv) return;
  const shadows = await allShadows();
  const all = await runTransaction(STORES, 'readonly', (tx) => {
    const reqs = STORES.map((n) => [n, tx.objectStore(n).getAll()]);
    return () => reqs.map(([n, r]) => [n, r.result || []]);
  });

  const ups = [];
  const dels = [];
  const seen = new Set();
  for (const [store, recs] of all) {
    const kp = keyPathOf(store);
    for (const rec of recs) {
      const key = rec[kp];
      if (key === undefined || key === null || key === '') continue;
      const id = sid(store, String(key));
      seen.add(id);
      const h = fingerprint(rec);
      const sh = shadows.get(id);
      if (!sh || sh.h !== h) ups.push({ id, store, key: String(key), rec, h });
    }
  }
  for (const [id, sh] of shadows) if (!seen.has(id)) dels.push({ id, store: sh.s, key: sh.k });

  let sendDels = dels;
  if (dels.length >= MASS_DELETE_MIN && dels.length > shadows.size * MASS_DELETE_SHARE && !massDeleteApproved) {
    sendDels = [];
    if (!status.massDelete || status.massDelete.count !== dels.length) setStatus({ massDelete: { count: dels.length } });
  } else if (status.massDelete) {
    setStatus({ massDelete: null });
  }
  setStatus({ pending: ups.length + sendDels.length });
  if (!ups.length && !sendDels.length) return;

  const device = deviceLabel();
  const nowIso = new Date().toISOString();
  let batch = [];
  let meta = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await http('/rest/v1/records?on_conflict=user_id,store,key', {
      method: 'POST',
      body: batch,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    await writeShadows(
      meta.filter((m) => m.h).map((m) => ({ id: m.id, s: m.store, k: m.key, h: m.h })),
      meta.filter((m) => !m.h).map((m) => m.id)
    );
    setStatus({ pending: Math.max(0, status.pending - batch.length) });
    batch = [];
    meta = [];
    bytes = 0;
  };

  for (const u of ups) {
    const data = await encodeRecord(u.store, u.rec);
    const row = { user_id: uidv, store: u.store, key: u.key, data, deleted: false, client_ts: u.rec.updatedAt || u.rec.createdAt || nowIso, device };
    const size = JSON.stringify(data).length + 200;
    if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_ROWS)) await flush();
    batch.push(row);
    meta.push({ id: u.id, store: u.store, key: u.key, h: u.h });
    bytes += size;
  }
  for (const d of sendDels) {
    if (batch.length >= MAX_BATCH_ROWS) await flush();
    batch.push({ user_id: uidv, store: d.store, key: d.key, data: null, deleted: true, client_ts: nowIso, device });
    meta.push({ id: d.id, store: d.store, key: d.key, h: null });
  }
  await flush();
  if (sendDels.length && massDeleteApproved) massDeleteApproved = false;
}

/** The user's answer to "delete N entries on all devices?". */
export async function resolveMassDelete(deleteEverywhere) {
  if (deleteEverywhere) {
    massDeleteApproved = true;
    setStatus({ massDelete: null });
    return syncNow();
  }
  // Keep them: forget the shadows of the missing records and re-download from the cloud.
  const shadows = await allShadows();
  const all = await runTransaction(STORES, 'readonly', (tx) => {
    const reqs = STORES.map((n) => [n, tx.objectStore(n).getAllKeys()]);
    return () => reqs.map(([n, r]) => [n, r.result || []]);
  });
  const present = new Set();
  for (const [store, keys] of all) for (const k of keys) present.add(sid(store, String(k)));
  const gone = [...shadows.keys()].filter((id) => !present.has(id));
  await writeShadows([], gone);
  await setState({ cursor: 0 });
  setStatus({ massDelete: null });
  return syncNow();
}

/** Re-download everything from the cloud (keeps local changes that are newer). */
export async function resyncAll() {
  await setState({ cursor: 0 });
  return syncNow();
}

function deviceLabel() {
  try {
    const ua = navigator.userAgent || '';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac OS X/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
  } catch {
    /* ignore */
  }
  return 'Browser';
}

// -------------------------------------------------------------------------------------------- realtime

let ws = null;
let wsHeartbeat = 0;
let wsRetry = 0;
let wsRetryTimer = 0;
let wsRef = 0;
let pollTimer = 0;
let loopsOn = false;
const TOPIC = 'realtime:daybook-records';

function wsSend(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function realtimeToken() {
  if (session) wsSend({ topic: TOPIC, event: 'access_token', payload: { access_token: session.access_token }, ref: String(++wsRef), join_ref: '1' });
}

function connectRealtime() {
  if (!session || ws || typeof WebSocket === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  let sock;
  try {
    sock = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SYNC_KEY)}&vsn=1.0.0`);
  } catch {
    return;
  }
  ws = sock;
  sock.onopen = async () => {
    let s = null;
    try {
      s = await validSession();
    } catch {
      s = session;
    }
    if (!s || ws !== sock) return;
    wsSend({
      topic: TOPIC,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: '' },
          postgres_changes: [{ event: '*', schema: 'public', table: 'records', filter: `user_id=eq.${s.user.id}` }],
          private: false,
        },
        access_token: s.access_token,
      },
      ref: String(++wsRef),
      join_ref: '1',
    });
    clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => wsSend({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++wsRef) }), 25000);
  };
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.event === 'postgres_changes') requestSync(400);
    else if (msg.event === 'phx_reply' && msg.topic === TOPIC && msg.payload && msg.payload.status === 'ok') wsRetry = 0;
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(wsHeartbeat);
    if (!session || !loopsOn) return;
    wsRetry = Math.min(wsRetry ? wsRetry * 2 : 2000, 60000);
    clearTimeout(wsRetryTimer);
    wsRetryTimer = setTimeout(connectRealtime, wsRetry);
  };
  sock.onerror = () => {
    /* onclose follows */
  };
}

function closeRealtime() {
  clearTimeout(wsRetryTimer);
  clearInterval(wsHeartbeat);
  const s = ws;
  ws = null;
  if (s) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}

function visible() {
  try {
    return document.visibilityState !== 'hidden';
  } catch {
    return true;
  }
}

function startLoops() {
  if (loopsOn) return;
  loopsOn = true;
  connectRealtime();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (visible()) requestSync(0);
  }, POLL_MS);
}

function stopLoops() {
  loopsOn = false;
  clearTimeout(timer);
  clearInterval(pollTimer);
  closeRealtime();
}

// -------------------------------------------------------------------------------------------- boot

let started = false;

/** Start syncing (call once at boot, after settings are loaded). Safe when not configured / signed out. */
export async function startSync() {
  if (started || !status.configured) return;
  started = true;

  on('db:change', (p) => {
    if (!session || (p && p.op === 'sync')) return;
    if (p && p.op === 'clear' && p.store === '*' && !sessionStillStored()) {
      endSession(null);
      return;
    }
    requestSync(1500);
  });
  window.addEventListener('online', () => {
    if (!session) return;
    connectRealtime();
    requestSync(300);
  });
  window.addEventListener('offline', () => {
    if (session) setStatus({ phase: 'offline' });
  });
  document.addEventListener('visibilitychange', () => {
    if (session && visible()) {
      connectRealtime();
      requestSync(300);
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY) return;
    const s = readStoredSession();
    if (!s && session) endSession(null);
    else if (s && !session) adoptSession(s);
    else if (s) session = s;
  });

  if (!session) {
    const stored = readStoredSession();
    if (stored) {
      session = stored;
      const st = await getState().catch(() => ({}));
      setStatus({ signedIn: true, email: stored.user.email, firstDone: !!st.firstDone });
      startLoops();
      requestSync(800);
    } else {
      // Not signed in: stale bookkeeping from an old session must never drive a later sync.
      const st = await getState().catch(() => ({}));
      if (st.userId || st.cursor) await resetSyncDb();
    }
  }
}

export const _test = { fingerprint, encodeRecord, decodeRecord };
