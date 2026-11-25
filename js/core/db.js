// IndexedDB wrapper (SPEC section 2 + 3.2).
//
// - One shared connection promise; one transaction per call; every promise settles (complete/error/abort).
// - Every write emits 'db:change' {store, op, key, record} AFTER the transaction has committed.
// - all/byDate/byRange/byIndex results are sorted by (date, time, createdAt) ascending.
//   Trades have no `time` field, so their time key is exitTime (closed) / entryTime (open).
// - put() fills id/createdAt/updatedAt on id stores, updatedAt on `days`, and leaves `meta` untouched.
//   put/bulkPut accept { touch:false } to keep timestamps exactly as given (used by backup import).
// Extras beyond the spec (safe to use): db.bulkDelete, db.getDays, emptyDay(), deepMerge(), clone(),
// runTransaction() (low level, used by backup.js), DB_NAME, DB_VERSION.

import { emit } from './bus.js';

export const DB_NAME = 'daybook';
export const DB_VERSION = 1;

const SCHEMA = {
  meta: { keyPath: 'key', indexes: [] },
  days: { keyPath: 'date', indexes: [] },
  food: { keyPath: 'id', indexes: ['date'] },
  learning: { keyPath: 'id', indexes: ['date', 'nextReview'] },
  workouts: { keyPath: 'id', indexes: ['date'] },
  expenses: { keyPath: 'id', indexes: ['date'] },
  trades: { keyPath: 'id', indexes: ['date', 'status', 'symbol'] },
  goals: { keyPath: 'id', indexes: [] },
  reviews: { keyPath: 'id', indexes: [] },
  files: { keyPath: 'id', indexes: [] },
};

export const STORES = Object.keys(SCHEMA);

export function keyPathOf(store) {
  return SCHEMA[store] ? SCHEMA[store].keyPath : null;
}

// ---------------------------------------------------------------------------------------------------
// Small utilities (exported for settings.js / metrics.js / backup.js)

export function uid() {
  try {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* insecure context (e.g. http://192.168.x.x) → fall through */
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep clone of plain data (Blobs/Dates kept as-is by structuredClone). */
export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  try {
    return structuredClone(v);
  } catch {
    if (Array.isArray(v)) return v.map(clone);
    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = clone(v[k]);
      return out;
    }
    return v;
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep merge: returns a NEW object, inputs are not mutated.
 * Plain objects merge recursively; arrays and primitives (incl. null/false) replace; `undefined` is skipped.
 */
export function deepMerge(base, patch) {
  if (patch === undefined) return clone(base);
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = patch[k];
    if (v === undefined) continue;
    if (isPlainObject(v)) out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v);
    else out[k] = Array.isArray(v) ? clone(v) : v;
  }
  return out;
}

/** Full default `days` record (SPEC 2.1). */
export function emptyDay(date) {
  return {
    date,
    water: 0,
    mood: null,
    energy: null,
    sleep: null,
    weight: null,
    steps: null,
    intention: '',
    wins: '',
    reflection: '',
    gratitude: '',
    checks: {},
    trading: {
      bias: '',
      watchlist: '',
      plan: '',
      maxLoss: null,
      moodBefore: null,
      rulesChecked: {},
      review: '',
      lessons: '',
      grade: '',
    },
  };
}

/** Guarantees the nested containers are objects even if stored/patched data held null or junk there. */
function normalizeDay(day, date) {
  const base = emptyDay(date);
  day.date = date;
  if (!isPlainObject(day.checks)) day.checks = {};
  if (!isPlainObject(day.trading)) day.trading = base.trading;
  else if (!isPlainObject(day.trading.rulesChecked)) day.trading.rulesChecked = {};
  return day;
}

function fullDay(date, stored) {
  return normalizeDay(deepMerge(emptyDay(date), isPlainObject(stored) ? stored : {}), date);
}

const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------
// Sorting

function timeKey(r) {
  if (r.time !== undefined && r.time !== null) return String(r.time);
  if (r.entryTime !== undefined || r.exitTime !== undefined) {
    return String((r.status === 'closed' ? r.exitTime || r.entryTime : r.entryTime) || '');
  }
  return '';
}

function compareRecords(a, b) {
  const da = String(a.date ?? '');
  const dbb = String(b.date ?? '');
  if (da !== dbb) return da < dbb ? -1 : 1;
  const ta = timeKey(a);
  const tb = timeKey(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ca = String(a.createdAt ?? '');
  const cb = String(b.createdAt ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return 0;
}

export function sortRecords(list) {
  return Array.isArray(list) ? list.sort(compareRecords) : [];
}

// ---------------------------------------------------------------------------------------------------
// Connection

let dbPromise = null;
let connection = null;

function resetConnection(conn) {
  if (!conn || connection === conn) {
    connection = null;
    dbPromise = null;
  }
}

function createSchema(database, upgradeTx) {
  for (const [name, def] of Object.entries(SCHEMA)) {
    const os = database.objectStoreNames.contains(name)
      ? upgradeTx.objectStore(name)
      : database.createObjectStore(name, { keyPath: def.keyPath });
    for (const idx of def.indexes) {
      if (!os.indexNames.contains(idx)) os.createIndex(idx, idx, { unique: false });
    }
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('Storage is not available in this browser (IndexedDB missing). Private mode may block it.'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        createSchema(req.result, req.transaction);
      } catch (err) {
        try {
          req.transaction.abort();
        } catch {
          /* ignore */
        }
        reject(err);
      }
    };
    req.onsuccess = () => {
      const conn = req.result;
      // Another tab (or a newer app version) wants to upgrade/delete: get out of the way.
      conn.onversionchange = () => {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        resetConnection(conn);
        emit('db:versionchange', {});
      };
      // Unexpected close (storage cleared by the browser, etc.) → reopen on next call.
      conn.onclose = () => resetConnection(conn);
      connection = conn;
      resolve(conn);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the database'));
    req.onblocked = () => {
      console.warn('[daybook] database open is blocked by another open tab; close other Daybook tabs.');
      emit('db:blocked', {});
    };
  });
}

/** Idempotent: returns the shared IDBDatabase connection (creating stores/indexes on first run). */
export async function openDB() {
  if (!dbPromise) {
    const p = connect();
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null; // allow a retry after a failure
    });
  }
  return dbPromise;
}

/**
 * Run `body(tx, abortWith)` inside one transaction. `body` may return a value or a function that is called
 * after the transaction completes (so request results can be collected). Rejects on error/abort — never hangs.
 * Code running later inside request callbacks must not throw: wrap it and call `abortWith(err)`, which aborts
 * the transaction and rejects with `err` (an exception escaping a callback would also abort, but it is
 * reported as an uncaught page error).
 */
export async function runTransaction(storeNames, mode, body, _retry = true) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  for (const n of names) {
    if (!SCHEMA[n]) throw new Error(`Unknown store "${n}"`);
  }
  const conn = await openDB();
  let tx;
  try {
    tx = conn.transaction(names, mode);
  } catch (err) {
    if (_retry && err && err.name === 'InvalidStateError') {
      // The connection was closed under us (versionchange) — reopen once.
      resetConnection(conn);
      return runTransaction(storeNames, mode, body, false);
    }
    throw err;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let out;
    let cause = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(cause || err || new Error('Database transaction failed'));
    };
    const abortWith = (err) => {
      if (!cause) cause = err || new Error('Database transaction failed');
      try {
        tx.abort();
      } catch {
        fail(cause); // already committing/finished
      }
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(typeof out === 'function' ? out() : out);
      } catch (err) {
        reject(err);
      }
    };
    tx.onerror = (e) => fail(tx.error || (e && e.target && e.target.error));
    tx.onabort = () => fail(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    try {
      out = body(tx, abortWith);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      fail(err);
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Record preparation

function prepare(store, record, touch) {
  if (!isPlainObject(record)) throw new TypeError(`db.put("${store}"): record must be a plain object`);
  const kp = keyPathOf(store);
  const r = { ...record };
  if (store === 'meta') {
    if (r.key === undefined || r.key === null || r.key === '') throw new Error('db.put("meta"): record.key is required');
    // Timestamped so cloud sync can tell which device changed a setting last (readers only use .value).
    if (touch || !r.updatedAt) r.updatedAt = nowISO();
    return r;
  }
  if (store === 'days') {
    if (!r.date) throw new Error('db.put("days"): record.date is required');
    if (touch || !r.updatedAt) r.updatedAt = nowISO();
    return r;
  }
  if (kp === 'id') {
    if (r.id === undefined || r.id === null || r.id === '') r.id = uid();
    const now = nowISO();
    if (!r.createdAt) r.createdAt = now;
    if (touch || !r.updatedAt) r.updatedAt = now;
  }
  return r;
}

function change(store, op, key, record, extra) {
  emit('db:change', { store, op, key: key ?? null, record: record ?? null, ...(extra || {}) });
}

function getAllReq(source, query) {
  return query === undefined ? source.getAll() : source.getAll(query);
}

function dateRange(from, to) {
  const f = from === undefined || from === null || from === '' ? null : String(from);
  const t = to === undefined || to === null || to === '' ? null : String(to);
  if (f !== null && t !== null) return f > t ? 'empty' : IDBKeyRange.bound(f, t);
  if (f !== null) return IDBKeyRange.lowerBound(f);
  if (t !== null) return IDBKeyRange.upperBound(t);
  return undefined;
}

function inRange(v, from, to) {
  if (v === undefined || v === null) return false;
  const s = String(v);
  if (from !== null && from !== undefined && from !== '' && s < String(from)) return false;
  if (to !== null && to !== undefined && to !== '' && s > String(to)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Public API

export const db = {
  async get(store, key) {
    if (key === undefined || key === null || key === '') return undefined;
    return runTransaction(store, 'readonly', (tx) => {
      const r = tx.objectStore(store).get(key);
      return () => r.result;
    });
  },

  async put(store, record, { touch = true } = {}) {
    const saved = prepare(store, record, touch);
    await runTransaction(store, 'readwrite', (tx) => {
      tx.objectStore(store).put(saved);
    });
    change(store, 'put', saved[keyPathOf(store)], saved);
    return saved;
  },

  async bulkPut(store, records, { touch = true } = {}) {
    const list = (Array.isArray(records) ? records : []).map((r) => prepare(store, r, touch));
    if (!list.length) return [];
    await runTransaction(store, 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      for (const r of list) os.put(r);
    });
    change(store, 'put', null, null, { records: list, count: list.length, bulk: true });
    return list;
  },

  async delete(store, key) {
    if (key === undefined || key === null || key === '') return undefined;
    const previous = await runTransaction(store, 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      const g = os.get(key);
      os.delete(key);
      return () => g.result;
    });
    change(store, 'delete', key, previous);
    return previous;
  },

  async bulkDelete(store, keys) {
    const list = (Array.isArray(keys) ? keys : []).filter((k) => k !== undefined && k !== null && k !== '');
    if (!list.length) return 0;
    await runTransaction(store, 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      for (const k of list) os.delete(k);
    });
    change(store, 'delete', null, null, { keys: list, count: list.length, bulk: true });
    return list.length;
  },

  async all(store) {
    const rows = await runTransaction(store, 'readonly', (tx) => {
      const r = tx.objectStore(store).getAll();
      return () => r.result;
    });
    return sortRecords(rows || []);
  },

  async byDate(store, dateKey) {
    if (!dateKey) return [];
    return db.byRange(store, dateKey, dateKey);
  },

  async byRange(store, fromKey, toKey) {
    const range = dateRange(fromKey, toKey);
    if (range === 'empty') return [];
    const rows = await runTransaction(store, 'readonly', (tx) => {
      const os = tx.objectStore(store);
      if (os.keyPath === 'date') {
        const r = getAllReq(os, range);
        return () => r.result;
      }
      if (os.indexNames.contains('date')) {
        const r = getAllReq(os.index('date'), range);
        return () => r.result;
      }
      // No date index (e.g. goals): scan and filter — graceful rather than throwing.
      const r = os.getAll();
      return () => (r.result || []).filter((x) => inRange(x.date, fromKey, toKey));
    });
    return sortRecords(rows || []);
  },

  async byIndex(store, indexName, value) {
    if (value === undefined || value === null) return [];
    const rows = await runTransaction(store, 'readonly', (tx) => {
      const r = tx.objectStore(store).index(indexName).getAll(value);
      return () => r.result;
    });
    return sortRecords(rows || []);
  },

  async count(store) {
    return runTransaction(store, 'readonly', (tx) => {
      const r = tx.objectStore(store).count();
      return () => r.result;
    });
  },

  async clear(store) {
    await runTransaction(store, 'readwrite', (tx) => {
      tx.objectStore(store).clear();
    });
    change(store, 'clear', null, null);
  },

  /** Always a full day object with defaults (deep-merged), even when nothing is stored. */
  async getDay(date) {
    const stored = date ? await db.get('days', date) : undefined;
    return fullDay(date, stored);
  },

  /** {[date]: fullDay} for every stored day in [from, to] (days with nothing stored are absent). */
  async getDays(from, to) {
    const rows = await db.byRange('days', from, to);
    const out = {};
    for (const r of rows) out[r.date] = fullDay(r.date, r);
    return out;
  },

  /** Deep-merge `patch` into the stored day (read + write in ONE transaction → no lost updates). */
  async patchDay(date, patch) {
    if (!date) throw new Error('db.patchDay: date is required');
    const p = isPlainObject(patch) ? patch : {};
    const saved = await runTransaction('days', 'readwrite', (tx, abortWith) => {
      const os = tx.objectStore('days');
      let next = null;
      const g = os.get(date);
      g.onsuccess = () => {
        try {
          next = normalizeDay(deepMerge(fullDay(date, g.result), p), date);
          // A user edit adopts a sample day, so "Remove sample data" never deletes the user's own input.
          if (!('sample' in p)) delete next.sample;
          next.updatedAt = nowISO();
          os.put(next);
        } catch (err) {
          abortWith(err); // e.g. DataCloneError for an uncloneable patch value
        }
      };
      return () => next;
    });
    change('days', 'put', date, saved, { patch: p });
    return saved;
  },

  async getMeta(key, fallback) {
    const rec = await db.get('meta', key);
    return rec && rec.value !== undefined ? rec.value : fallback;
  },

  async setMeta(key, value) {
    await db.put('meta', { key, value });
    return value;
  },
};
