// Backup / restore / CSV (SPEC 3.11).
// - exportAll(): one read transaction over every store (consistent snapshot). files → {id, type, dataUrl, createdAt, …}.
// - importBackup(): validates BEFORE touching anything, decodes files, then writes everything in ONE
//   readwrite transaction (atomic: a failure leaves the database untouched).
//     replace → every store is cleared first, then the backup is written as-is (settings included).
//     merge   → a record is written when missing locally or when its updatedAt is newer.
//               files and non-settings meta are only added when missing.
//               settings: current settings are kept, unless the current app is not onboarded (then the
//               backup's settings are used). When kept, categories/accounts/setups/… that exist only in the
//               backup are appended so imported records never point at unknown ids.
//   Afterwards: await loadSettings(), emit db:change {store:'*', op:'import'} and settings:change
//   ({settings, patch: settings} — "everything may have changed"). Returns counts of written records per store.
// - shareBackup(): Web Share with a file when allowed; some Android browsers refuse .json, so a .txt copy is
//   tried next; otherwise (or on NotAllowedError) it downloads. Restore inputs should accept .json and .txt.
// - clearAllData(): clears every store + 'daybook*' keys in local/sessionStorage, reloads default settings.

import { db, STORES, keyPathOf, runTransaction, uid, isPlainObject } from './db.js';
import { emit } from './bus.js';
import { getSettings, loadSettings, updateSettings, expenseCategory, incomeCategory, learningCategory, workoutType, tradingAccount } from './settings.js';
import { todayKey, startOfMonth, endOfMonth, monthOf, isValidKey } from './dates.js';
import { tradeGross, tradeNet, tradeR, MARKET_LABELS } from '../modules/trades/calc.js';

export const BACKUP_SCHEMA = 1;

// ---------------------------------------------------------------------------------------------------
// Blob ⇄ data URL

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('Could not read image'));
    r.readAsDataURL(blob);
  });
}

export function dataURLToBlob(url) {
  if (typeof url !== 'string') return null;
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const parts = meta.split(';');
  const mime = parts[0] || 'application/octet-stream';
  const isB64 = parts.slice(1).includes('base64');
  try {
    if (isB64) {
      const bin = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Export

async function fileToJSON(rec) {
  const { blob, ...rest } = rec || {};
  let dataUrl = typeof rest.dataUrl === 'string' ? rest.dataUrl : null;
  if (!dataUrl && blob instanceof Blob) dataUrl = await blobToDataURL(blob);
  return { ...rest, id: rest.id, type: rest.type || (blob && blob.type) || '', dataUrl, createdAt: rest.createdAt || null };
}

/** → {app:'daybook', schema:1, exportedAt, stores:{name:[...]}} */
export async function exportAll() {
  const raw = await runTransaction(STORES, 'readonly', (tx) => {
    const reqs = STORES.map((name) => [name, tx.objectStore(name).getAll()]);
    return () => Object.fromEntries(reqs.map(([name, r]) => [name, r.result || []]));
  });
  const stores = {};
  for (const name of STORES) {
    stores[name] = name === 'files' ? await Promise.all(raw.files.map(fileToJSON)) : raw[name];
  }
  return { app: 'daybook', schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(), stores };
}

export function backupCounts(backup) {
  const out = {};
  const s = (backup && backup.stores) || {};
  for (const name of STORES) out[name] = Array.isArray(s[name]) ? s[name].length : 0;
  return out;
}

const backupName = () => `daybook-backup-${todayKey()}.json`;

/** Downloads 'daybook-backup-YYYY-MM-DD.json' and records settings.lastBackupAt. */
export async function downloadBackup() {
  const data = await exportAll();
  const text = JSON.stringify(data);
  const filename = backupName();
  downloadText(filename, text, 'application/json');
  await updateSettings({ lastBackupAt: new Date().toISOString() });
  return { method: 'download', filename, bytes: text.length, counts: backupCounts(data) };
}

/** Web Share API with the backup file when available, else download. → {method:'share'|'download'|'cancelled', filename} */
export async function shareBackup() {
  const data = await exportAll();
  const text = JSON.stringify(data);
  const filename = backupName();
  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  if (canShareFiles) {
    const candidates = [];
    try {
      candidates.push(new File([text], filename, { type: 'application/json' }));
      candidates.push(new File([text], filename.replace(/\.json$/, '.txt'), { type: 'text/plain' }));
    } catch {
      /* File constructor unsupported */
    }
    const file = candidates.find((f) => {
      try {
        return navigator.canShare({ files: [f] });
      } catch {
        return false;
      }
    });
    if (file) {
      try {
        await navigator.share({ files: [file], title: 'Daybook backup', text: `Daybook backup · ${todayKey()}` });
        await updateSettings({ lastBackupAt: new Date().toISOString() });
        return { method: 'share', filename: file.name, bytes: text.length, counts: backupCounts(data) };
      } catch (err) {
        if (err && err.name === 'AbortError') return { method: 'cancelled', filename: file.name };
        // NotAllowedError (user activation expired) etc. → fall back to a download
      }
    }
  }
  downloadText(filename, text, 'application/json');
  await updateSettings({ lastBackupAt: new Date().toISOString() });
  return { method: 'download', filename, bytes: text.length, counts: backupCounts(data) };
}

// ---------------------------------------------------------------------------------------------------
// Import

async function readBackup(input) {
  if (input === null || input === undefined) throw new Error('Choose a backup file to restore.');
  let data = input;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const text = await input.text();
    data = text;
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data.replace(/^﻿/, ''));
    } catch {
      throw new Error("That file isn't a valid Daybook backup (it couldn't be read as JSON).");
    }
  }
  if (!isPlainObject(data) || data.app !== 'daybook' || !isPlainObject(data.stores)) {
    throw new Error("That file isn't a Daybook backup.");
  }
  if (Number(data.schema) > BACKUP_SCHEMA) {
    throw new Error('This backup was made by a newer version of Daybook. Update the app and try again.');
  }
  return data;
}

function prepareImport(name, row) {
  if (!isPlainObject(row)) return null;
  const r = { ...row };
  delete r.__proto__; // own "__proto__" key from JSON.parse — never carry it
  if (name === 'meta') return r.key !== undefined && r.key !== null && r.key !== '' ? r : null;
  if (name === 'days') return isValidKey(r.date) ? r : null;
  if (name === 'files') {
    const { dataUrl, ...rest } = r;
    const blob = r.blob instanceof Blob ? r.blob : dataURLToBlob(dataUrl);
    if (!blob || !rest.id) return null;
    return { ...rest, blob, type: rest.type || blob.type || '' };
  }
  if (keyPathOf(name) === 'id' && (r.id === undefined || r.id === null || r.id === '')) r.id = uid();
  return r;
}

const stamp = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

function shouldWrite(name, existing, incoming) {
  if (!existing) return true;
  if (name === 'files' || name === 'meta') return false;
  return stamp(incoming.updatedAt) > stamp(existing.updatedAt);
}

function unionById(current, incoming) {
  if (!Array.isArray(incoming)) return null;
  const cur = Array.isArray(current) ? current : [];
  const ids = new Set(cur.map((c) => c && c.id));
  const add = incoming.filter((c) => isPlainObject(c) && c.id && !ids.has(c.id));
  return add.length ? [...cur, ...add] : null;
}

function unionStrings(current, incoming) {
  if (!Array.isArray(incoming)) return null;
  const cur = Array.isArray(current) ? current : [];
  const seen = new Set(cur.map((s) => String(s).toLowerCase()));
  const add = [];
  for (const s of incoming) {
    if (typeof s !== 'string' || !s.trim() || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    add.push(s);
  }
  return add.length ? [...cur, ...add] : null;
}

/** Settings patch adding lists that exist only in the backup (null when nothing to add). */
function settingsAdditions(current, incoming) {
  if (!isPlainObject(incoming)) return null;
  const patch = {};
  for (const k of ['expenseCategories', 'incomeCategories', 'learningCategories', 'workoutTypes']) {
    const u = unionById(current[k], incoming[k]);
    if (u) patch[k] = u;
  }
  const pm = unionStrings(current.paymentMethods, incoming.paymentMethods);
  if (pm) patch.paymentMethods = pm;
  const ct = current.trading || {};
  const it = isPlainObject(incoming.trading) ? incoming.trading : {};
  const trading = {};
  for (const k of ['accounts', 'rules']) {
    const u = unionById(ct[k], it[k]);
    if (u) trading[k] = u;
  }
  for (const k of ['setups', 'mistakes', 'emotions', 'tags', 'markets']) {
    const u = unionStrings(ct[k], it[k]);
    if (u) trading[k] = u;
  }
  if (Object.keys(trading).length) patch.trading = trading;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Restore a backup (File/Blob, JSON string or parsed object).
 * → counts of written records per store, e.g. {food: 120, trades: 40, …}
 */
export async function importBackup(fileOrObject, { mode = 'merge' } = {}) {
  const replace = mode === 'replace';
  const data = await readBackup(fileOrObject);

  const prepared = {};
  for (const name of STORES) {
    const rows = data.stores[name];
    if (!Array.isArray(rows)) continue;
    prepared[name] = rows.map((row) => prepareImport(name, row)).filter(Boolean);
  }

  const current = getSettings();
  const keepSettings = !replace && !!current.onboarded;
  const incomingSettingsRec = (prepared.meta || []).find((r) => r.key === 'settings');
  const counts = Object.fromEntries(STORES.map((n) => [n, 0]));
  const names = replace ? STORES : Object.keys(prepared);

  if (names.length) {
    await runTransaction(names, 'readwrite', (tx, abortWith) => {
      for (const name of names) {
        const os = tx.objectStore(name);
        const rows = prepared[name] || [];
        const kp = keyPathOf(name);
        if (replace) {
          os.clear();
          for (const r of rows) {
            os.put(r);
            counts[name]++;
          }
          continue;
        }
        for (const r of rows) {
          if (name === 'meta' && r.key === 'settings') {
            if (keepSettings) continue;
            os.put(r);
            counts.meta++;
            continue;
          }
          const g = os.get(r[kp]);
          g.onsuccess = () => {
            try {
              if (shouldWrite(name, g.result, r)) {
                os.put(r);
                counts[name]++;
              }
            } catch (err) {
              abortWith(err); // whole import rolls back
            }
          };
        }
      }
    });
  }

  if (keepSettings && incomingSettingsRec) {
    const additions = settingsAdditions(current, incomingSettingsRec.value);
    if (additions) {
      try {
        await updateSettings(additions);
      } catch (err) {
        console.warn('[daybook] could not merge settings lists from backup', err);
      }
    }
  }

  const settings = await loadSettings();
  emit('db:change', { store: '*', op: 'import', key: null, record: null, counts, mode: replace ? 'replace' : 'merge' });
  emit('settings:change', { settings, patch: settings });
  return counts;
}

/** Clears every store (incl. settings) and Daybook's local/session storage keys. */
export async function clearAllData() {
  await runTransaction(STORES, 'readwrite', (tx) => {
    for (const name of STORES) tx.objectStore(name).clear();
  });
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      const s = globalThis[storage];
      const keys = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith('daybook')) keys.push(k);
      }
      keys.forEach((k) => s.removeItem(k));
    } catch {
      /* storage blocked */
    }
  }
  const settings = await loadSettings();
  emit('db:change', { store: '*', op: 'clear', key: null, record: null });
  emit('settings:change', { settings, patch: settings });
}

// ---------------------------------------------------------------------------------------------------
// CSV

const FORMULA_RE = /^[=@\t\r]|^[+-](?![\d.\s])/;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (Array.isArray(v)) s = v.filter((x) => x !== null && x !== undefined && x !== '').join('; ');
  else if (typeof v === 'boolean') s = v ? 'Yes' : 'No';
  else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? '' : v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (typeof v === 'string' && FORMULA_RE.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function inferColumns(rows) {
  const keys = [];
  const seen = new Set();
  for (const r of rows || []) {
    for (const k of Object.keys(r || {})) {
      if (k === 'blob' || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
  }
  return keys.map((k) => ({ key: k, label: k }));
}

/** columns: [{key, label} | {value(row), label} | 'key'] → RFC 4180 CSV (CRLF line breaks). */
export function toCSV(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = (Array.isArray(columns) && columns.length ? columns : inferColumns(list)).map((c) =>
    typeof c === 'string' ? { key: c, label: c } : c,
  );
  const lines = [cols.map((c) => csvCell(c.label ?? c.key ?? '')).join(',')];
  for (const row of list) {
    lines.push(
      cols
        .map((c) => {
          let v;
          try {
            v = typeof c.value === 'function' ? c.value(row) : row ? row[c.key] : undefined;
          } catch {
            v = '';
          }
          return csvCell(v);
        })
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/** Save text as a file (Blob + <a download>; the object URL is revoked afterwards). */
export function downloadText(filename, text, mime = 'text/plain') {
  const type = /charset=/i.test(mime) ? mime : `${mime};charset=utf-8`;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }
}

const cap = (s) => (typeof s === 'string' && s ? s.charAt(0).toUpperCase() + s.slice(1) : s ?? '');
const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');

function summarizeExercises(list, unit) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.name)
    .map((e) => {
      const sets = (Array.isArray(e.sets) ? e.sets : []).filter((s) => s && (s.reps || s.weight));
      if (!sets.length) return e.name;
      const same = sets.every((s) => s.reps === sets[0].reps && s.weight === sets[0].weight);
      if (same) {
        const s = sets[0];
        return `${e.name} ${sets.length}×${s.reps ?? '?'}${s.weight ? ` @ ${s.weight} ${unit}` : ''}`;
      }
      return `${e.name} ${sets.map((s) => (s.weight ? `${s.reps ?? '?'}×${s.weight}` : `${s.reps}`)).join(', ')}${
        sets.some((s) => s.weight) ? ` ${unit}` : ''
      }`;
    })
    .join('; ');
}

function columnsFor(store) {
  const s = getSettings();
  const cur = s.currency || '';
  const tcur = (s.trading && s.trading.currency) || cur;
  const wUnit = (s.units && s.units.weight) || 'kg';
  const dUnit = (s.units && s.units.distance) || 'km';
  switch (store) {
    case 'expenses':
      return [
        { key: 'date', label: 'Date' },
        { key: 'time', label: 'Time' },
        { label: 'Type', value: (r) => (r.type === 'income' ? 'Income' : 'Expense') },
        { label: 'Category', value: (r) => (r.type === 'income' ? incomeCategory(r.category) : expenseCategory(r.category)).name },
        { label: `Amount (${cur})`, value: (r) => r.amount },
        { key: 'method', label: 'Method' },
        { key: 'note', label: 'Note' },
        { key: 'tags', label: 'Tags' },
      ];
    case 'trades':
      return [
        { key: 'date', label: 'Date' },
        { key: 'symbol', label: 'Symbol' },
        { label: 'Market', value: (r) => MARKET_LABELS[r.market] || cap(r.market) },
        { label: 'Direction', value: (r) => cap(r.direction) },
        { label: 'Status', value: (r) => cap(r.status) },
        { label: 'Account', value: (r) => tradingAccount(r.accountId).name },
        { key: 'entryDate', label: 'Entry date' },
        { key: 'entryTime', label: 'Entry time' },
        { key: 'entryPrice', label: 'Entry price' },
        { key: 'exitDate', label: 'Exit date' },
        { key: 'exitTime', label: 'Exit time' },
        { key: 'exitPrice', label: 'Exit price' },
        { key: 'quantity', label: 'Quantity' },
        { key: 'multiplier', label: 'Multiplier' },
        { key: 'fees', label: `Fees (${tcur})` },
        { key: 'stopLoss', label: 'Stop loss' },
        { key: 'target', label: 'Target' },
        { label: `Gross P&L (${tcur})`, value: (r) => round(tradeGross(r)) },
        { label: `Net P&L (${tcur})`, value: (r) => round(tradeNet(r)) },
        { label: 'R multiple', value: (r) => round(tradeR(r)) },
        { key: 'setup', label: 'Setup' },
        { key: 'timeframe', label: 'Timeframe' },
        { key: 'confidence', label: 'Confidence (1-5)' },
        { key: 'rating', label: 'Execution (1-5)' },
        { label: 'Followed plan', value: (r) => yesNo(r.followedPlan) },
        { key: 'emotions', label: 'Emotions' },
        { key: 'mistakes', label: 'Mistakes' },
        { key: 'tags', label: 'Tags' },
        { key: 'thesis', label: 'Thesis' },
        { key: 'review', label: 'Review' },
      ];
    case 'food':
      return [
        { key: 'date', label: 'Date' },
        { key: 'time', label: 'Time' },
        { label: 'Meal', value: (r) => cap(r.meal) },
        { key: 'title', label: 'Food' },
        { key: 'calories', label: 'Calories (kcal)' },
        { key: 'protein', label: 'Protein (g)' },
        { key: 'carbs', label: 'Carbs (g)' },
        { key: 'fat', label: 'Fat (g)' },
        { label: 'Quality', value: (r) => cap(r.quality) },
        { key: 'note', label: 'Note' },
      ];
    case 'workouts':
      return [
        { key: 'date', label: 'Date' },
        { key: 'time', label: 'Time' },
        { label: 'Type', value: (r) => workoutType(r.type).name },
        { key: 'title', label: 'Title' },
        { key: 'duration', label: 'Duration (min)' },
        { key: 'intensity', label: 'Intensity (RPE 1-10)' },
        { key: 'calories', label: 'Calories burned' },
        { key: 'distance', label: `Distance (${dUnit})` },
        { key: 'feeling', label: 'Feeling (1-5)' },
        { label: 'Exercises', value: (r) => summarizeExercises(r.exercises, wUnit) },
        { key: 'notes', label: 'Notes' },
      ];
    case 'learning':
      return [
        { key: 'date', label: 'Date' },
        { key: 'title', label: 'Title' },
        { key: 'takeaway', label: 'Key takeaway' },
        { label: 'Category', value: (r) => learningCategory(r.category).name },
        { label: 'Source', value: (r) => cap(r.source) },
        { key: 'sourceName', label: 'Source name' },
        { key: 'link', label: 'Link' },
        { key: 'minutes', label: 'Minutes' },
        { key: 'tags', label: 'Tags' },
        { label: 'Starred', value: (r) => yesNo(!!r.starred) },
        { key: 'nextReview', label: 'Next review' },
        { key: 'notes', label: 'Notes' },
      ];
    case 'days':
      return [
        { key: 'date', label: 'Date' },
        { key: 'mood', label: 'Mood (1-5)' },
        { key: 'energy', label: 'Energy (1-5)' },
        { key: 'sleep', label: 'Sleep (h)' },
        { key: 'weight', label: `Weight (${wUnit})` },
        { key: 'steps', label: 'Steps' },
        { key: 'water', label: 'Water (glasses)' },
        { key: 'intention', label: 'Intention' },
        { key: 'wins', label: 'Wins' },
        { key: 'reflection', label: 'Reflection' },
        { key: 'gratitude', label: 'Gratitude' },
        { label: 'Market bias', value: (r) => cap(r.trading && r.trading.bias) },
        { label: 'Watchlist', value: (r) => r.trading && r.trading.watchlist },
        { label: 'Trading plan', value: (r) => r.trading && r.trading.plan },
        { label: `Max loss (${tcur})`, value: (r) => r.trading && r.trading.maxLoss },
        { label: 'Trading review', value: (r) => r.trading && r.trading.review },
        { label: 'Lessons', value: (r) => r.trading && r.trading.lessons },
        { label: 'Grade', value: (r) => r.trading && r.trading.grade },
      ];
    case 'goals':
      return [
        { key: 'title', label: 'Goal' },
        { label: 'Kind', value: (r) => (r.kind === 'check' ? 'Manual' : 'Auto') },
        { key: 'metric', label: 'Metric' },
        { label: 'Rule', value: (r) => (r.kind === 'check' ? '' : r.comparator === 'lte' ? 'at most' : 'at least') },
        { key: 'target', label: 'Target' },
        { label: 'Days', value: (r) => (Array.isArray(r.weekdays) && r.weekdays.length ? r.weekdays.join(' ') : 'Every day') },
        { label: 'Active', value: (r) => yesNo(r.active !== false) },
      ];
    case 'reviews':
      return [
        { key: 'period', label: 'Period' },
        { label: 'Type', value: (r) => cap(r.type) },
        { key: 'rating', label: 'Rating (1-5)' },
        { key: 'wentWell', label: 'What went well' },
        { key: 'improve', label: 'What to improve' },
        { key: 'focus', label: 'Focus next' },
      ];
    default:
      return null;
  }
}

function csvFilename(store, from, to) {
  const label = store === 'workouts' ? 'training' : store === 'days' ? 'journal' : store;
  let suffix;
  if (from && to) {
    if (from === startOfMonth(from) && to === endOfMonth(from)) suffix = monthOf(from);
    else if (from === to) suffix = from;
    else suffix = `${from}_to_${to}`;
  } else if (from) suffix = `from-${from}`;
  else if (to) suffix = `until-${to}`;
  else suffix = todayKey();
  return `daybook-${label}-${suffix}.csv`;
}

/**
 * Export one store as CSV (downloads by default). `from`/`to` filter by the date index.
 * → {filename, csv, count}
 */
export async function exportCSV(store, { from, to, download = true } = {}) {
  if (!STORES.includes(store)) throw new Error(`Unknown store "${store}"`);
  const rows = from || to ? await db.byRange(store, from, to) : await db.all(store);
  const csv = toCSV(rows, columnsFor(store) || inferColumns(rows));
  const filename = csvFilename(store, from, to);
  if (download) downloadText(filename, '﻿' + csv, 'text/csv'); // BOM → Excel reads UTF-8 (₹, emoji)
  return { filename, csv, count: rows.length };
}
