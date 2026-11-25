// Daybook core test-suite — runs against the REAL modules in a fresh IndexedDB.
// Open tools/tests/core.html via tools/serve.py. Results: window.__testResults / window.__testsDone.

import { on, emit, state } from '../../js/core/bus.js';
import { db, openDB, STORES, uid, deepMerge, emptyDay } from '../../js/core/db.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  getSettings,
  updateSettings,
  isSettingsLoaded,
  expenseCategory,
  incomeCategory,
  learningCategory,
  workoutType,
  tradingAccount,
} from '../../js/core/settings.js';
import * as D from '../../js/core/dates.js';
import * as F from '../../js/core/format.js';
import * as M from '../../js/core/metrics.js';
import * as B from '../../js/core/backup.js';
import * as C from '../../js/modules/trades/calc.js';

// ---------------------------------------------------------------------------------------------------
// Tiny harness

const results = [];
let currentGroup = 'general';
const queue = [];

function group(name) {
  currentGroup = name;
}
function test(name, fn) {
  queue.push({ group: currentGroup, name, fn });
}

class AssertionError extends Error {}
const show = (v) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (x === Infinity ? 'Infinity' : x));
  } catch {
    return String(v);
  }
};
function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new AssertionError(msg);
}
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
function eq(actual, expected, msg = '') {
  if (!deepEqual(actual, expected)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
}
function approx(actual, expected, eps = 1e-6, msg = '') {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
    throw new AssertionError(`${msg ? msg + ': ' : ''}expected ≈${expected}, got ${show(actual)}`);
  }
}
async function rejects(promiseOrFn, msg = 'expected a rejection') {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    return err;
  }
  throw new AssertionError(msg);
}
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new AssertionError(`timed out after ${ms} ms (${label}) — a promise hung`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}
function capture(event) {
  const list = [];
  const off = on(event, (p) => list.push(p));
  return { list, off };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MINUS = '−';

async function resetStores() {
  for (const s of STORES) await db.clear(s);
  await loadSettings();
}

// ---------------------------------------------------------------------------------------------------
// Rendering

const $results = document.getElementById('results');
const $summary = document.getElementById('summary');
const $bar = document.getElementById('bar');
const sections = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderResult(r) {
  let sec = sections.get(r.group);
  if (!sec) {
    const s = el('section');
    const h = el('h2', '', r.group);
    const count = el('span');
    h.append(count);
    const ul = el('ul');
    s.append(h, ul);
    $results.append(s);
    sec = { ul, count, pass: 0, total: 0 };
    sections.set(r.group, sec);
  }
  sec.total++;
  if (r.ok) sec.pass++;
  sec.count.textContent = `${sec.pass}/${sec.total}`;
  const li = el('li');
  li.append(el('span', r.ok ? 'ok' : 'bad', r.ok ? '✓' : '✗'), el('span', '', r.name), el('span', 'ms', `${r.ms} ms`));
  if (!r.ok) li.append(el('pre', '', r.error));
  sec.ul.append(li);
  const done = results.length;
  const failed = results.filter((x) => !x.ok).length;
  $bar.firstElementChild.style.width = `${Math.round((done / queue.length) * 100)}%`;
  $bar.classList.toggle('has-fail', failed > 0);
}

function renderSummary(passed, failed, ms) {
  $summary.replaceChildren(
    el('span', 'pill pass', `${passed} passed`),
    el('span', 'pill fail', `${failed} failed`),
    el('span', 'pill', `${(ms / 1000).toFixed(1)} s`),
  );
}

// ===================================================================================================
// TESTS
// ===================================================================================================

const TODAY = D.todayKey();

// --------------------------------------------------------------------------------------------- bus
group('bus');

test('on / emit / off', () => {
  const got = [];
  const off = on('test:evt', (p) => got.push(p));
  emit('test:evt', 1);
  off();
  emit('test:evt', 2);
  eq(got, [1]);
  off(); // idempotent
});

test('a throwing listener does not break the others', () => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    const got = [];
    const off1 = on('test:boom', () => {
      throw new Error('boom');
    });
    const off2 = on('test:boom', (p) => got.push(p));
    emit('test:boom', 'x');
    off1();
    off2();
    eq(got, ['x']);
    assert(logged.length === 1, 'error was logged');
  } finally {
    console.error = orig;
  }
});

test('state.date defaults to today', () => {
  eq(state.date, TODAY);
});

// ---------------------------------------------------------------------------------------------- db
group('db');

test('openDB is idempotent and creates every store + index', async () => {
  const a = await openDB();
  const b = await openDB();
  assert(a === b, 'same connection');
  eq([...a.objectStoreNames].sort(), [...STORES].sort());
  const tx = a.transaction(['trades', 'learning', 'food'], 'readonly');
  eq([...tx.objectStore('trades').indexNames].sort(), ['date', 'status', 'symbol']);
  eq([...tx.objectStore('learning').indexNames].sort(), ['date', 'nextReview']);
  eq(tx.objectStore('food').keyPath, 'id');
  eq(a.version, 1);
});

test('uid() is unique and UUID-shaped', () => {
  const ids = new Set(Array.from({ length: 200 }, uid));
  eq(ids.size, 200);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test([...ids][0]), 'uuid v4 format');
});

test('put fills id/createdAt/updatedAt and returns the saved record', async () => {
  const ev = capture('db:change');
  const saved = await db.put('food', { date: '2026-11-20', time: '08:00', meal: 'breakfast', title: 'Oats' });
  ev.off();
  assert(typeof saved.id === 'string' && saved.id.length > 10, 'id generated');
  assert(saved.createdAt && saved.updatedAt, 'timestamps');
  const got = await db.get('food', saved.id);
  eq(got, saved, 'stored = returned');
  eq(ev.list.length, 1, 'one event');
  eq(ev.list[0].store, 'food');
  eq(ev.list[0].op, 'put');
  eq(ev.list[0].key, saved.id);
  eq(ev.list[0].record.title, 'Oats');
});

test('re-put keeps createdAt, bumps updatedAt; input is not mutated', async () => {
  const input = { date: '2026-11-20', title: 'Tea' };
  const a = await db.put('food', input);
  assert(!('id' in input), 'input not mutated');
  await sleep(5);
  const b = await db.put('food', { ...a, title: 'Green tea' });
  eq(b.id, a.id);
  eq(b.createdAt, a.createdAt);
  assert(b.updatedAt > a.updatedAt, 'updatedAt bumped');
  const kept = await db.put('food', { ...b, updatedAt: '2020-01-01T00:00:00.000Z' }, { touch: false });
  eq(kept.updatedAt, '2020-01-01T00:00:00.000Z', 'touch:false keeps timestamps');
});

test('days get updatedAt; meta gets only updatedAt (for sync)', async () => {
  const day = await db.put('days', { date: '2026-11-19', water: 3 });
  assert(day.updatedAt, 'days updatedAt');
  assert(!('id' in day) && !('createdAt' in day), 'no id/createdAt on days');
  const meta = await db.put('meta', { key: 'x', value: 42 });
  assert(meta.updatedAt, 'meta updatedAt');
  eq({ key: meta.key, value: meta.value }, { key: 'x', value: 42 });
  eq(await db.get('meta', 'x'), meta);
});

test('results are sorted by date, time, createdAt', async () => {
  await db.clear('food');
  await db.put('food', { id: 'c', date: '2026-11-02', time: '13:00', title: 'c', createdAt: '2026-01-01T00:00:03Z' });
  await db.put('food', { id: 'a', date: '2026-11-01', time: '20:00', title: 'a', createdAt: '2026-01-01T00:00:09Z' });
  await db.put('food', { id: 'd', date: '2026-11-02', time: '13:00', title: 'd', createdAt: '2026-01-01T00:00:05Z' });
  await db.put('food', { id: 'b', date: '2026-11-02', time: '08:30', title: 'b', createdAt: '2026-01-01T00:00:01Z' });
  await db.put('food', { id: 'e', date: '2026-11-03', time: '', title: 'e' });
  eq((await db.all('food')).map((r) => r.id), ['a', 'b', 'c', 'd', 'e'], 'all');
  eq((await db.byDate('food', '2026-11-02')).map((r) => r.id), ['b', 'c', 'd'], 'byDate');
  eq((await db.byRange('food', '2026-11-01', '2026-11-02')).map((r) => r.id), ['a', 'b', 'c', 'd'], 'byRange inclusive');
  eq((await db.byRange('food', '2026-11-03', '2026-11-01')).length, 0, 'from > to → []');
  eq((await db.byRange('food', '2026-11-02', null)).map((r) => r.id), ['b', 'c', 'd', 'e'], 'open-ended');
});

test('trades sort by exit/entry time; byIndex works', async () => {
  await db.clear('trades');
  await db.put('trades', C.prepareTrade({ id: 't2', symbol: 'b', status: 'closed', entryDate: '2026-11-02', entryTime: '09:20', exitTime: '11:00', entryPrice: 1, exitPrice: 2, quantity: 1 }));
  await db.put('trades', C.prepareTrade({ id: 't1', symbol: 'a', status: 'closed', entryDate: '2026-11-02', entryTime: '09:30', exitTime: '10:00', entryPrice: 1, exitPrice: 2, quantity: 1 }));
  await db.put('trades', C.prepareTrade({ id: 't3', symbol: 'a', status: 'open', entryDate: '2026-11-02', entryTime: '12:00', entryPrice: 1, quantity: 1 }));
  eq((await db.byDate('trades', '2026-11-02')).map((t) => t.id), ['t1', 't2', 't3']);
  eq((await db.byIndex('trades', 'status', 'open')).map((t) => t.id), ['t3']);
  eq((await db.byIndex('trades', 'symbol', 'A')).map((t) => t.id).sort(), ['t1', 't3']);
  eq((await db.byIndex('trades', 'date', IDBKeyRange.bound('2026-11-01', '2026-11-30'))).length, 3, 'key range');
});

test('byRange works on days (key) and on stores without a date index', async () => {
  await db.put('days', { date: '2026-11-18', water: 1 });
  const days = await db.byRange('days', '2026-11-18', '2026-11-19');
  eq(days.map((d) => d.date), ['2026-11-18', '2026-11-19']);
  await db.put('goals', { id: 'gx', title: 'x', date: '2026-11-18' });
  eq((await db.byRange('goals', '2026-11-01', '2026-11-30')).map((g) => g.id), ['gx']);
  await db.delete('goals', 'gx');
});

test('count / delete (returns previous) / clear / bulkPut / bulkDelete', async () => {
  await db.clear('expenses');
  const ev = capture('db:change');
  const saved = await db.bulkPut('expenses', [
    { date: '2026-11-01', type: 'expense', amount: 10 },
    { date: '2026-11-02', type: 'expense', amount: 20 },
    { date: '2026-11-03', type: 'income', amount: 30 },
  ]);
  eq(saved.length, 3);
  assert(saved.every((r) => r.id && r.createdAt), 'ids filled');
  eq(ev.list.length, 1, 'bulkPut emits ONE event');
  eq(await db.count('expenses'), 3);
  const prev = await db.delete('expenses', saved[0].id);
  eq(prev.amount, 10, 'delete returns previous record');
  eq(await db.count('expenses'), 2);
  eq(await db.bulkDelete('expenses', [saved[1].id]), 1);
  await db.clear('expenses');
  eq(await db.count('expenses'), 0);
  ev.off();
  eq(ev.list.map((e) => e.op), ['put', 'delete', 'delete', 'clear']);
  eq(ev.list[1].record.amount, 10, 'delete event carries record');
});

test('getDay returns full defaults (incl. nested trading) for missing and partial days', async () => {
  const empty = await db.getDay('2030-01-01');
  eq(empty, emptyDay('2030-01-01'));
  eq(empty.trading.rulesChecked, {});
  await db.put('days', { date: '2026-11-17', mood: 4, trading: { bias: 'bullish' }, checks: { g1: true } });
  const d = await db.getDay('2026-11-17');
  eq(d.mood, 4);
  eq(d.water, 0, 'default water');
  eq(d.trading.bias, 'bullish');
  eq(d.trading.plan, '', 'nested default kept');
  eq(d.trading.grade, '');
  eq(d.trading.maxLoss, null);
  eq(d.checks, { g1: true });
  assert(d.updatedAt, 'stored updatedAt kept');
  // junk nested containers (e.g. from an old/hand-edited backup) are normalised
  await db.put('days', { date: '2026-11-13', checks: null, trading: null });
  const j = await db.getDay('2026-11-13');
  eq([j.checks, j.trading], [{}, emptyDay('x').trading], 'null containers → defaults');
  const jp = await db.patchDay('2026-11-13', { trading: { rulesChecked: null, bias: 'neutral' } });
  eq([jp.trading.rulesChecked, jp.trading.bias, jp.trading.plan], [{}, 'neutral', '']);
});

test('patchDay deep-merges objects, replaces arrays/primitives, stores false', async () => {
  const ev = capture('db:change');
  await db.patchDay('2026-11-16', { checks: { g1: true, g2: true }, trading: { bias: 'bearish', rulesChecked: { r1: true } } });
  const s1 = await db.patchDay('2026-11-16', { checks: { g1: false }, trading: { plan: 'Wait for ORB' }, water: 4, tags: ['a', 'b'] });
  eq(s1.checks, { g1: false, g2: true }, 'false stored, sibling kept');
  eq(s1.trading.bias, 'bearish');
  eq(s1.trading.plan, 'Wait for ORB');
  eq(s1.trading.rulesChecked, { r1: true });
  eq(s1.water, 4);
  const s2 = await db.patchDay('2026-11-16', { tags: ['c'], mood: 3 });
  eq(s2.tags, ['c'], 'arrays replace');
  const s3 = await db.patchDay('2026-11-16', { mood: null, water: undefined });
  eq(s3.mood, null, 'null replaces');
  eq(s3.water, 4, 'undefined is skipped');
  const stored = await db.get('days', '2026-11-16');
  eq(stored.checks.g1, false, 'false persisted (not deleted)');
  eq(stored.trading.review, '', 'defaults persisted');
  ev.off();
  assert(ev.list.every((e) => e.store === 'days' && e.op === 'put' && e.key === '2026-11-16'), 'events');
  eq(ev.list.length, 4);
});

test('concurrent patchDay calls never lose updates', async () => {
  await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => db.patchDay('2026-11-15', { checks: { [k]: true } })));
  const d = await db.getDay('2026-11-15');
  eq(Object.keys(d.checks).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('getMeta / setMeta', async () => {
  eq(await db.getMeta('nope', 'fallback'), 'fallback');
  await db.setMeta('k1', { a: 1 });
  eq(await db.getMeta('k1'), { a: 1 });
  await db.setMeta('k2', 0);
  eq(await db.getMeta('k2', 5), 0, 'falsy value is not replaced by fallback');
});

test('failures reject instead of hanging', async () => {
  await rejects(db.put('days', { water: 1 }), 'days without date');
  await rejects(db.put('meta', { value: 1 }), 'meta without key');
  await rejects(db.put('nope', { a: 1 }), 'unknown store');
  await rejects(db.all('nope'), 'unknown store read');
  await rejects(db.byIndex('food', 'nope', 'x'), 'unknown index');
  await rejects(db.put('food', { id: 'f1', date: '2026-01-01', fn: () => 1 }), 'uncloneable value (DataCloneError)');
  await rejects(db.patchDay(null, {}), 'patchDay without date');
  // failure INSIDE a request callback (put of an uncloneable value) must abort + reject, not hang
  const cloneErr = await rejects(withTimeout(db.patchDay('2026-11-14', { fn: () => 1 }), 4000, 'patchDay DataCloneError'), 'patchDay uncloneable');
  eq(cloneErr.name, 'DataCloneError', 'original error surfaces');
  eq(await db.get('days', '2026-11-14'), undefined, 'aborted patch wrote nothing');
  await rejects(withTimeout(db.get('food', { bad: 'key' }), 4000, 'invalid key'), 'invalid key type (DataError)');
  eq(await db.get('food', null), undefined, 'null key → undefined');
  eq(await db.get('food', 'missing'), undefined);
  // still healthy afterwards
  const ok = await db.put('food', { date: '2026-01-01', title: 'ok' });
  assert(ok.id, 'db still works');
});

test('deepMerge: no input mutation, prototype keys ignored', () => {
  const base = { a: { b: 1, c: [1, 2] }, d: 1 };
  const patch = JSON.parse('{"a":{"c":[3]},"__proto__":{"polluted":true},"e":false}');
  const out = deepMerge(base, patch);
  eq(out, { a: { b: 1, c: [3] }, d: 1, e: false });
  eq(base, { a: { b: 1, c: [1, 2] }, d: 1 }, 'base untouched');
  assert(!({}).polluted && !out.polluted, 'no prototype pollution');
  out.a.c.push(9);
  eq(patch.a.c, [3], 'arrays are copied');
});

// ----------------------------------------------------------------------------------------- settings
group('settings');

test('defaults are complete and colors are distinct hex values', () => {
  const s = DEFAULT_SETTINGS;
  eq(s.currency, 'USD');
  eq(s.weekStart, 1);
  eq(s.targets.water, 8);
  eq(s.expenseCategories.length, 14);
  eq(s.incomeCategories.length, 7);
  eq(s.learningCategories.length, 10);
  eq(s.workoutTypes.length, 8);
  eq(s.trading.rules.length, 4);
  eq(s.trading.accounts[0].id, 'main');
  for (const key of ['expenseCategories', 'incomeCategories', 'learningCategories', 'workoutTypes']) {
    const list = s[key];
    eq(new Set(list.map((c) => c.id)).size, list.length, `${key} unique ids`);
    assert(list.every((c) => /^#[0-9a-f]{6}$/i.test(c.color) && c.name && c.emoji), `${key} fields`);
    const nonOther = list.filter((c) => c.id !== 'other').map((c) => c.color.toLowerCase());
    eq(new Set(nonOther).size, nonOther.length, `${key} distinct colors`);
  }
  eq(expenseCategory('food').name, 'Food & dining');
  eq(expenseCategory('bills').name, 'Bills & utilities');
  eq(learningCategory('growth').name, 'Personal growth');
  eq(learningCategory('trading').name, 'Trading & markets');
});

test('getSettings works before loadSettings (defaults)', async () => {
  if (!isSettingsLoaded()) eq(getSettings().currency, 'USD');
  const s = await loadSettings();
  eq(s, DEFAULT_SETTINGS, 'empty store → defaults');
  assert(s !== DEFAULT_SETTINGS && s.targets !== DEFAULT_SETTINGS.targets, 'a copy, not the defaults object');
});

test('stored settings deep-merge over defaults (arrays replace)', async () => {
  await db.setMeta('settings', {
    currency: 'INR',
    targets: { water: 10 },
    expenseCategories: [{ id: 'x', name: 'X', emoji: '❌', color: '#000000' }],
    trading: { currency: 'USD' },
  });
  const s = await loadSettings();
  eq(s.currency, 'INR');
  eq(s.targets.water, 10);
  eq(s.targets.protein, 100, 'sibling default kept');
  eq(s.expenseCategories.length, 1, 'stored array replaces defaults');
  eq(s.trading.currency, 'USD');
  eq(s.trading.setups, DEFAULT_SETTINGS.trading.setups, 'nested default arrays kept');
  eq(s.incomeCategories.length, 7);
  eq(expenseCategory('food').name, 'Other', 'unknown id → fallback');
  eq(expenseCategory('food').emoji, '📦');
  eq(expenseCategory('food').id, 'food');
});

test('updateSettings merges, persists, emits, mirrors theme', async () => {
  const ev = capture('settings:change');
  const s = await updateSettings({ targets: { protein: 120 }, theme: 'dark' });
  ev.off();
  eq(s.targets.protein, 120);
  eq(s.targets.water, 10, 'previous value kept');
  eq(getSettings(), s);
  eq(ev.list.length, 1);
  eq(ev.list[0].patch, { targets: { protein: 120 }, theme: 'dark' });
  eq(ev.list[0].settings.targets.protein, 120);
  eq((await db.getMeta('settings')).targets.protein, 120, 'persisted');
  eq(localStorage.getItem('daybook.theme'), 'dark', 'theme mirrored');
  await updateSettings({ theme: 'system' });
  eq(localStorage.getItem('daybook.theme'), 'system');
  eq(DEFAULT_SETTINGS.targets.protein, 100, 'defaults never mutated');
  eq(DEFAULT_SETTINGS.expenseCategories.length, 14);
});

test('lookups + fallbacks', async () => {
  await db.delete('meta', 'settings');
  await loadSettings();
  eq(incomeCategory('salary').emoji, '💼');
  eq(incomeCategory('zzz').name, 'Other');
  eq(workoutType('yoga').name, 'Yoga');
  eq(workoutType(undefined).name, 'Other');
  eq(tradingAccount().id, 'main');
  eq(tradingAccount('main').name, 'Main account');
  eq(tradingAccount('ghost').name, 'ghost');
});

// -------------------------------------------------------------------------------------------- dates
group('dates');

test('toKey / fromKey / isValidKey (local time)', () => {
  eq(D.toKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  eq(D.toKey(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
  eq(D.toKey('2026-11-24'), '2026-11-24');
  eq(D.toKey('2026-02-30'), null);
  eq(D.toKey(null), null);
  eq(D.toKey('garbage'), null);
  const d = D.fromKey('2026-11-24');
  eq([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 24, 0, 0]);
  eq(D.fromKey('bad'), null);
  assert(D.isValidKey('2024-02-29') && !D.isValidKey('2026-02-29'), 'leap check');
  eq(D.todayKey(), D.toKey(new Date()));
});

test('addDays across month / year / leap day; diffDays', () => {
  eq(D.addDays('2026-01-31', 1), '2026-02-01');
  eq(D.addDays('2026-12-31', 1), '2027-01-01');
  eq(D.addDays('2027-01-01', -1), '2026-12-31');
  eq(D.addDays('2026-03-01', -1), '2026-02-28');
  eq(D.addDays('2024-02-28', 1), '2024-02-29');
  eq(D.addDays('2026-11-24', 0), '2026-11-24');
  eq(D.addDays('2026-11-24', 400), '2027-12-29');
  eq(D.addDays(null, 1), null);
  eq(D.diffDays('2026-11-01', '2026-11-24'), 23);
  eq(D.diffDays('2026-11-24', '2026-11-01'), -23);
  eq(D.diffDays('2026-12-31', '2027-01-01'), 1);
  eq(D.diffDays(null, '2026-01-01'), null);
});

test('DST-safe arithmetic (US + EU transitions)', () => {
  for (const [a, b] of [
    ['2026-03-08', '2026-03-09'],
    ['2026-03-29', '2026-03-30'],
    ['2026-11-01', '2026-11-02'],
    ['2026-10-25', '2026-10-26'],
  ]) {
    eq(D.addDays(a, 1), b, `addDays ${a}`);
    eq(D.addDays(b, -1), a, `addDays back ${b}`);
    eq(D.diffDays(a, b), 1, `diffDays ${a}`);
  }
  const march = D.rangeKeys('2026-03-01', '2026-03-31');
  eq(march.length, 31);
  eq(new Set(march).size, 31, 'no duplicates');
  eq(march[30], '2026-03-31');
  const oct = D.rangeKeys('2026-10-20', '2026-11-05');
  eq(oct.length, 17);
  eq(oct.indexOf('2026-10-26') - oct.indexOf('2026-10-25'), 1);
});

test('startOfWeek / endOfWeek for Monday and Sunday starts', () => {
  // 2026-11-24 is a Tuesday, 2026-11-22 a Sunday
  eq(D.weekday('2026-11-24'), 2);
  eq(D.weekday('2026-11-22'), 0);
  eq(D.startOfWeek('2026-11-24', 1), '2026-11-23');
  eq(D.startOfWeek('2026-11-24', 0), '2026-11-22');
  eq(D.startOfWeek('2026-11-22', 1), '2026-11-16');
  eq(D.startOfWeek('2026-11-22', 0), '2026-11-22');
  eq(D.startOfWeek('2026-11-23', 1), '2026-11-23');
  eq(D.endOfWeek('2026-11-24', 1), '2026-11-29');
  eq(D.endOfWeek('2026-11-24', 0), '2026-11-28');
  eq(D.startOfWeek('2027-01-01', 1), '2026-12-28');
  eq(D.weekKeys('2026-11-24', 1), D.rangeKeys('2026-11-23', '2026-11-29'));
  eq(D.startOfWeek(null), null);
});

test('weekStart defaults to settings', async () => {
  await updateSettings({ weekStart: 0 });
  eq(D.startOfWeek('2026-11-24'), '2026-11-22');
  eq(D.weekdayLabels(undefined, 'short').length, 7);
  await updateSettings({ weekStart: 1 });
  eq(D.startOfWeek('2026-11-24'), '2026-11-23');
});

test('isoWeek edge cases + weekRange', () => {
  eq(D.isoWeek('2026-01-01'), '2026-W01');
  eq(D.isoWeek('2027-01-01'), '2026-W53');
  eq(D.isoWeek('2020-12-31'), '2020-W53');
  eq(D.isoWeek('2021-01-03'), '2020-W53');
  eq(D.isoWeek('2021-01-04'), '2021-W01');
  eq(D.isoWeek('2024-12-30'), '2025-W01');
  eq(D.isoWeek('2026-11-24'), '2026-W48');
  eq(D.isoWeek(null), null);
  eq(D.weekRange('2026-W48'), { from: '2026-11-23', to: '2026-11-29' });
  eq(D.weekRange('2020-W53'), { from: '2020-12-28', to: '2021-01-03' });
  eq(D.weekRange('2026-W01'), { from: '2025-12-29', to: '2026-01-04' });
  eq(D.weekRange('2026-W53'), { from: '2026-12-28', to: '2027-01-03' });
  // round trip over two years
  for (const k of D.rangeKeys('2025-12-01', '2027-01-31')) {
    const r = D.weekRange(D.isoWeek(k));
    assert(k >= r.from && k <= r.to, `round trip ${k}`);
  }
});

test('rangeKeys and month helpers', () => {
  eq(D.rangeKeys('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  eq(D.rangeKeys('2026-01-02', '2026-01-01'), []);
  eq(D.rangeKeys('2026-01-01', '2026-01-01'), ['2026-01-01']);
  eq(D.rangeKeys(null, '2026-01-01'), []);
  eq(D.monthOf('2026-11-24'), '2026-11');
  eq(D.addMonths('2026-11', 2), '2027-01');
  eq(D.addMonths('2026-01', -1), '2025-12');
  eq(D.addMonths('2026-01', -13), '2024-12');
  eq(D.addMonths('2026-01-31', 1), '2026-02-28');
  eq(D.daysInMonth('2024-02'), 29);
  eq(D.daysInMonth('2026-02'), 28);
  eq(D.daysInMonth('2026-12-05'), 31);
  eq(D.startOfMonth('2026-11-24'), '2026-11-01');
  eq(D.startOfMonth('2026-11'), '2026-11-01');
  eq(D.endOfMonth('2026-11'), '2026-11-30');
  eq(D.endOfMonth('2024-02-10'), '2024-02-29');
  eq(D.monthKeys('2026-02').length, 28);
});

test('relative / future / clamp / time helpers', () => {
  eq(D.relativeDay(TODAY), 'Today');
  eq(D.relativeDay(D.addDays(TODAY, -1)), 'Yesterday');
  eq(D.relativeDay(D.addDays(TODAY, 1)), 'Tomorrow');
  eq(D.relativeDay(D.addDays(TODAY, -5)), D.fmtDate(D.addDays(TODAY, -5), 'medium'));
  assert(D.isFuture(D.addDays(TODAY, 1)) && !D.isFuture(TODAY), 'isFuture');
  eq(D.clampToToday(D.addDays(TODAY, 3)), TODAY);
  eq(D.clampToToday('2020-01-01'), '2020-01-01');
  assert(/^\d{2}:\d{2}$/.test(D.nowTime()), 'nowTime HH:MM');
  eq(D.timeToMinutes('06:30'), 390);
  eq(D.minutesToTime(390), '06:30');
  eq(D.greeting(new Date(2026, 0, 1, 9)), 'Good morning');
  eq(D.greeting(new Date(2026, 0, 1, 14)), 'Good afternoon');
  eq(D.greeting(new Date(2026, 0, 1, 20)), 'Good evening');
});

test('Intl formatting (locale aware)', () => {
  const t = D.fmtTime('18:30');
  assert(/6:30|18:30/.test(t), `fmtTime → ${t}`);
  eq(D.fmtTime(''), '');
  eq(D.fmtTime(null), '');
  eq(D.fmtDate(null), '—');
  const long = D.fmtDate('2026-11-24', 'long');
  assert(long.includes('2026') && long.includes('November') && long.includes('Tuesday'), `long → ${long}`);
  const short = D.fmtDate('2026-11-24', 'short');
  assert(short.includes('24') && short.includes('Nov') && !short.includes('2026'), `short → ${short}`);
  const med = D.fmtDate('2026-11-24', 'medium');
  assert(med.includes('Tue') && med.includes('24'), `medium → ${med}`);
  eq(D.fmtDate('2026-11-24', 'weekday'), 'Tue');
  const my = D.fmtDate('2026-11-24', 'monthYear');
  assert(my.includes('Nov') && my.includes('2026'), `monthYear → ${my}`);
  const m = D.fmtMonth('2026-11');
  assert(m.includes('November') && m.includes('2026'), `fmtMonth → ${m}`);
  eq(D.fmtMonth(null), '—');
  const labels = D.weekdayLabels(1, 'short');
  eq(labels[0], 'Mon');
  eq(D.weekdayLabels(0, 'short')[0], 'Sun');
  assert(D.fmtRange('2026-11-23', '2026-11-29').includes('Nov'), 'fmtRange');
});

// ------------------------------------------------------------------------------------------- format
group('format');

test('fmtMoney signs use + and true minus U+2212', () => {
  const pos = F.fmtMoney(1200, { sign: true, currency: 'INR' });
  assert(pos.startsWith('+') && pos.includes('₹') && /1,200|1\.200|1 200/.test(pos), `+ → ${pos}`);
  const neg = F.fmtMoney(-300, { sign: true, currency: 'INR' });
  assert(neg.startsWith(MINUS) && !neg.includes('-') && neg.includes('300'), `− → ${neg}`);
  const neg2 = F.fmtMoney(-300, { currency: 'INR' });
  assert(neg2.startsWith(MINUS), `no sign option still uses true minus → ${neg2}`);
  const zero = F.fmtMoney(0, { sign: true, currency: 'INR' });
  assert(!zero.startsWith('+') && !zero.startsWith(MINUS), `zero unsigned → ${zero}`);
  const tiny = F.fmtMoney(-0.001, { sign: true, currency: 'USD' });
  assert(!tiny.startsWith(MINUS), `rounds to zero → unsigned (${tiny})`);
});

test('fmtMoney null/NaN → — and default decimals', () => {
  for (const v of [null, undefined, NaN, '', 'abc']) eq(F.fmtMoney(v), '—', `input ${String(v)}`);
  assert(F.fmtMoney(12.5, { currency: 'USD' }).includes('12.50'), F.fmtMoney(12.5, { currency: 'USD' }));
  const big = F.fmtMoney(1234.56, { currency: 'USD' });
  assert(big.includes('1,235') && !big.includes('.'), `|n|>=1000 → 0 decimals (${big})`);
  assert(!F.fmtMoney(12, { currency: 'USD' }).includes('.'), 'integer → 0 decimals');
  assert(F.fmtMoney(1234.5, { decimals: 2, currency: 'USD' }).includes('1,234.50'), 'decimals override');
  assert(!F.fmtMoney(12.5, { currency: 'JPY' }).includes('.'), 'JPY has no minor units');
  assert(F.fmtMoney('250', { currency: 'USD' }).includes('250'), 'numeric strings accepted');
  const c = F.fmtMoney(1500000, { compact: true, currency: 'USD' });
  assert(c.length < F.fmtMoney(1500000, { currency: 'USD' }).length && /\d/.test(c) && c.includes('$'), `compact → ${c}`);
  const ci = F.fmtMoney(-2500, { compact: true, sign: true, currency: 'INR' });
  assert(ci.startsWith(MINUS) && /2\.5/.test(ci), `compact signed → ${ci}`);
});

test('currency symbols, list, trade currency', async () => {
  eq(F.currencySymbol('INR'), '₹');
  eq(F.currencySymbol('USD'), '$');
  eq(F.currencySymbol('EUR'), '€');
  assert(F.CURRENCIES.length >= 30, 'currency count');
  eq(new Set(F.CURRENCIES.map((c) => c.code)).size, F.CURRENCIES.length, 'unique codes');
  for (const c of F.CURRENCIES) {
    assert(c.name, `${c.code} has a name`);
    new Intl.NumberFormat('en', { style: 'currency', currency: c.code }); // throws if invalid
  }
  await updateSettings({ currency: 'INR', trading: { currency: null } });
  eq(F.tradeCurrency(), 'INR');
  assert(F.fmtMoney(5).includes('₹'), 'app currency default');
  await updateSettings({ trading: { currency: 'USD' } });
  eq(F.tradeCurrency(), 'USD');
  assert(F.fmtTradeMoney(5).includes('$'), 'fmtTradeMoney uses trading currency');
  await updateSettings({ trading: { currency: null } });
  eq(F.guessCurrency('en-IN'), 'INR');
  eq(F.guessCurrency('en-US'), 'USD');
  eq(F.guessCurrency('en-GB'), 'GBP');
  eq(F.guessCurrency('de-DE'), 'EUR');
});

test('fmtNumber / fmtPercent / fmtPrice trimming', () => {
  eq(F.fmtNumber(1234.5), '1,235');
  eq(F.fmtNumber(7.25), '7.25');
  eq(F.fmtNumber(7.5, { decimals: 2 }), '7.50');
  eq(F.fmtNumber(5, { sign: true }), '+5');
  eq(F.fmtNumber(-5, { sign: true }), MINUS + '5');
  eq(F.fmtNumber(null), '—');
  assert(/^52[.,]3\s?%$/.test(F.fmtPercent(0.523)), F.fmtPercent(0.523));
  eq(F.fmtPercent(0.5), '50%');
  eq(F.fmtPercent(1), '100%');
  eq(F.fmtPercent(0.12345, { decimals: 2 }), '12.35%');
  assert(F.fmtPercent(-0.1, { sign: true }).startsWith(MINUS), 'percent sign');
  assert(F.fmtPercent(0.1, { sign: true }).startsWith('+'), 'percent plus');
  eq(F.fmtPercent(null), '—');
  eq(F.fmtPercent(NaN), '—');
  eq(F.fmtPrice(1.5), '1.5');
  eq(F.fmtPrice(1.5), F.fmtPrice(1.5));
  eq(F.fmtPrice(0.00001234), '0.00001234');
  eq(F.fmtPrice(100), '100');
  eq(F.fmtPrice(0.1 + 0.2), '0.3');
  eq(F.fmtPrice(24350.25), '24,350.25');
  eq(F.fmtPrice(1.123456789), '1.12345679');
  eq(F.fmtPrice(null), '—');
});

test('fmtDuration / fmtR / pnlTone / units', async () => {
  eq(F.fmtDuration(45), '45m');
  eq(F.fmtDuration(80), '1h 20m');
  eq(F.fmtDuration(120), '2h');
  eq(F.fmtDuration(4560), '3d 4h');
  eq(F.fmtDuration(0), '0m');
  eq(F.fmtDuration(null), '—');
  eq(F.fmtR(1.8), '+1.8R');
  eq(F.fmtR(-0.5), MINUS + '0.5R');
  eq(F.fmtR(2), '+2.0R');
  eq(F.fmtR(null), '—');
  eq(F.pnlTone(5), 'profit');
  eq(F.pnlTone(-1), 'loss');
  eq(F.pnlTone(0), 'neutral');
  eq(F.pnlTone(null), 'neutral');
  eq(F.fmtWeight(72.45), '72.5 kg');
  eq(F.fmtDistance(5.255), '5.26 km');
  await updateSettings({ units: { weight: 'lb', distance: 'mi' } });
  eq(F.fmtWeight(160), '160 lb');
  eq(F.fmtDistance(3.1), '3.1 mi');
  await updateSettings({ units: { weight: 'kg', distance: 'km' } });
  eq(F.fmtWeight(null), '—');
  eq(F.plural(1, 'meal'), '1 meal');
  eq(F.plural(3, 'entry', 'entries'), '3 entries');
});

// ------------------------------------------------------------------------------------------ metrics
group('metrics');

const DAY = D.addDays(TODAY, -3);
const EMPTY = D.addDays(TODAY, -20);

async function seedMetricsDay() {
  await resetStores();
  await db.patchDay(DAY, { water: 8, mood: 4, energy: 3, sleep: 7.5, steps: 9000, weight: 72, reflection: 'Good day', checks: { 'g-check': true } });
  await db.put('food', { date: DAY, time: '08:00', meal: 'breakfast', title: 'Oats', calories: 600, protein: 30, carbs: 80, fat: 12 });
  await db.put('food', { date: DAY, time: '13:00', meal: 'lunch', title: 'Dal rice', calories: 900, protein: 45, carbs: 120, fat: 20 });
  await db.put('workouts', { date: DAY, time: '07:00', type: 'cardio', duration: 45, distance: 5, calories: 300 });
  await db.put('workouts', { date: DAY, time: '18:00', type: 'strength', duration: 20 });
  await db.put('learning', { date: DAY, title: 'Kelly criterion', minutes: 15 });
  await db.put('expenses', { date: DAY, time: '09:00', type: 'expense', amount: 250, category: 'food' });
  await db.put('expenses', { date: DAY, time: '10:00', type: 'expense', amount: 100, category: 'transport' });
  await db.put('expenses', { date: DAY, time: '11:00', type: 'income', amount: 5000, category: 'salary' });
  const tr = (t) => db.put('trades', C.prepareTrade(t));
  await tr({ symbol: 'nifty', direction: 'long', status: 'closed', entryDate: DAY, entryTime: '09:30', exitTime: '10:15', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 5, stopLoss: 95 });
  await tr({ symbol: 'tcs', direction: 'short', status: 'closed', entryDate: DAY, entryTime: '11:00', exitTime: '11:30', entryPrice: 50, exitPrice: 52, quantity: 10 });
  await tr({ symbol: 'infy', direction: 'long', status: 'open', entryDate: DAY, entryTime: '14:00', entryPrice: 1500, quantity: 2 });
}

test('metricsForDay aggregates every store', async () => {
  await seedMetricsDay();
  const m = await M.getDayMetrics(DAY);
  eq(m.date, DAY);
  eq([m.calories, m.protein, m.carbs, m.fat, m.meals], [1500, 75, 200, 32, 2], 'food');
  eq(m.water, 8);
  eq([m.trainingMinutes, m.workouts, m.distance, m.caloriesBurned], [65, 2, 5, 300], 'training');
  eq([m.steps, m.weight, m.sleep, m.mood, m.energy], [9000, 72, 7.5, 4, 3], 'day');
  eq([m.learnings, m.learningMinutes], [1, 15], 'learning');
  eq([m.spend, m.income, m.expenseCount], [350, 5000, 2], 'expenses');
  eq([m.trades, m.tradesOpened, m.tradePnl, m.tradeWins, m.tradeLosses], [3, 3, 75, 1, 1], 'trades');
  eq(m.reflection, 1);
  eq(m.hasAny, true);
  const e = await M.getDayMetrics(EMPTY);
  eq([e.hasAny, e.calories, e.meals, e.water, e.steps, e.mood, e.reflection, e.tradePnl], [false, 0, 0, 0, 0, null, 0, 0]);
});

test('loadRangeData + getRangeMetrics', async () => {
  const data = await M.loadRangeData(D.addDays(DAY, -1), DAY);
  eq(data.food.length, 2);
  eq(data.trades.length, 3);
  assert(data.days[DAY] && data.days[DAY].trading && data.days[DAY].trading.plan === '', 'days are full records');
  const r = await M.getRangeMetrics(D.addDays(DAY, -2), DAY);
  eq(Object.keys(r), D.rangeKeys(D.addDays(DAY, -2), DAY));
  eq(r[DAY].meals, 2);
  eq(r[D.addDays(DAY, -1)].hasAny, false);
});

test('evaluateGoal: gte / lte / requiresData / check / weekdays', async () => {
  const m = await M.getDayMetrics(DAY);
  const e = await M.getDayMetrics(EMPTY);
  const water8 = { id: 'gw', kind: 'metric', metric: 'water', comparator: 'gte', target: 8 };
  const r1 = M.evaluateGoal(water8, m);
  eq([r1.done, r1.value, r1.target, r1.progress, r1.over, r1.applicable], [true, 8, 8, 1, false, true]);
  const r2 = M.evaluateGoal({ ...water8, target: 10 }, m);
  eq([r2.done, r2.progress], [false, 0.8]);

  const cal = { id: 'gc', kind: 'metric', metric: 'calories', comparator: 'lte', target: 2000 };
  eq(M.evaluateGoal(cal, m).done, true, 'lte under target');
  eq(M.evaluateGoal(cal, m).progress, 0.75, 'lte progress = used fraction');
  const noData = M.evaluateGoal(cal, e);
  eq([noData.done, noData.noData], [false, true], 'requiresData: no meals → not done');
  const overR = M.evaluateGoal({ ...cal, target: 1000 }, m);
  eq([overR.done, overR.over, overR.progress], [false, true, 1]);

  const spend = { id: 'gs', kind: 'metric', metric: 'spend', comparator: 'lte', target: 500 };
  eq(M.evaluateGoal(spend, m).done, true);
  eq(M.evaluateGoal(spend, e).done, true, 'spend (no requiresData) done on empty day');
  eq(M.evaluateGoal({ ...spend, target: 300 }, m).over, true);

  const sleep = { id: 'gsl', kind: 'metric', metric: 'sleep', comparator: 'gte', target: 7 };
  eq(M.evaluateGoal(sleep, m).done, true);
  eq(M.evaluateGoal(sleep, e).done, false, 'null sleep not done');

  const check = { id: 'g-check', kind: 'check', title: 'Meditate' };
  eq(M.evaluateGoal(check, m).done, true);
  eq(M.evaluateGoal(check, e).done, false);

  const refl = { id: 'gr', kind: 'metric', metric: 'reflection', comparator: 'gte', target: 1 };
  eq(M.evaluateGoal(refl, m).done, true);
  const wd = D.weekday(DAY);
  eq(M.evaluateGoal({ ...water8, weekdays: [(wd + 1) % 7] }, m).applicable, false);
  eq(M.evaluateGoal({ ...water8, weekdays: [wd] }, m).applicable, true);
  eq(M.evaluateGoal({ ...water8, comparator: undefined }, m).comparator, 'gte', 'comparator from METRICS');
});

test('getGoalsForDay + getDayScores', async () => {
  const wd = D.weekday(DAY);
  await db.bulkPut('goals', [
    { id: 'g1', kind: 'metric', metric: 'water', comparator: 'gte', target: 8, active: true, order: 2 },
    { id: 'g2', kind: 'metric', metric: 'calories', comparator: 'lte', target: 2000, active: true, order: 1 },
    { id: 'g-check', kind: 'check', title: 'Meditate', active: true, order: 0 },
    { id: 'g4', kind: 'metric', metric: 'water', comparator: 'gte', target: 1, active: false, order: 3 },
    { id: 'g5', kind: 'metric', metric: 'water', comparator: 'gte', target: 1, active: true, order: 4, weekdays: [(wd + 1) % 7] },
  ]);
  const list = await M.getGoalsForDay(DAY);
  eq(list.map((x) => x.goal.id), ['g-check', 'g2', 'g1'], 'active + applicable, ordered');
  assert(list.every((x) => x.done), 'all done');
  let scores = await M.getDayScores(DAY, DAY);
  eq(scores[DAY], { score: 1, done: 3, total: 3 });
  await db.put('goals', { id: 'g6', kind: 'metric', metric: 'protein', comparator: 'gte', target: 100, active: true, order: 5 });
  scores = await M.getDayScores(D.addDays(DAY, -1), D.addDays(TODAY, 1));
  eq(scores[DAY].score, 0.75, '3 of 4');
  eq(scores[D.addDays(DAY, -1)].done, 0);
  eq(scores[D.addDays(TODAY, 1)].score, null, 'future → null');
  await db.clear('goals');
  scores = await M.getDayScores(DAY, DAY);
  eq(scores[DAY].score, null, 'no goals → null');
});

test('logging streak (today counts, else continues from yesterday) + goal streak', async () => {
  await resetStores();
  const logged = [0, 1, 2, 4, 5, 6, 7, 8]; // gap at 3 → current 3, best 5
  for (const n of logged) await db.patchDay(D.addDays(TODAY, -n), { water: 2 });
  let s = await M.getLoggingStreak();
  eq([s.current, s.best], [3, 5]);
  await db.delete('days', TODAY);
  s = await M.getLoggingStreak();
  eq([s.current, s.best], [2, 5], 'today not logged yet → streak from yesterday');
  await db.put('learning', { date: TODAY, title: 'x' });
  s = await M.getLoggingStreak();
  eq(s.current, 3, 'any module counts as a log');

  await db.put('goals', { id: 'gw', kind: 'metric', metric: 'water', comparator: 'gte', target: 2, active: true, order: 0 });
  let gs = await M.getGoalStreak('gw');
  eq([gs.current, gs.best], [2, 5], 'goal streak; today unmet does not break it');
  await db.patchDay(TODAY, { water: 3 });
  gs = await M.getGoalStreak('gw');
  eq([gs.current, gs.best], [3, 5]);
  eq(await M.getGoalStreak('missing'), { current: 0, best: 0 });
  const hist = await M.getGoalHistory('gw', D.addDays(TODAY, -3), TODAY);
  eq(Object.values(hist).map((h) => h.done), [false, true, true, true]);
});

test('defaultGoals(settings)', () => {
  const s0 = deepMerge(DEFAULT_SETTINGS, { targets: { dailySpend: 0 } });
  const g0 = M.defaultGoals(s0);
  eq(g0.map((g) => g.metric), ['water', 'protein', 'trainingMinutes', 'learnings', 'reflection', 'sleep']);
  const s1 = deepMerge(DEFAULT_SETTINGS, { targets: { dailySpend: 500, water: 10 }, currency: 'INR' });
  const g1 = M.defaultGoals(s1);
  eq(g1.length, 7);
  const spend = g1.find((g) => g.metric === 'spend');
  eq([spend.comparator, spend.target], ['lte', 500]);
  eq(g1.find((g) => g.metric === 'water').target, 10);
  eq(g1.find((g) => g.metric === 'trainingMinutes').target, 30);
  eq(g1.find((g) => g.metric === 'sleep').target, 8);
  eq(g1.find((g) => g.metric === 'protein').target, 100);
  eq(new Set(g1.map((g) => g.id)).size, 7, 'unique ids');
  g1.forEach((g, i) => {
    assert(g.id && g.title && g.icon && g.color && g.color.startsWith('--') && g.active === true && g.kind === 'metric', `fields ${g.id}`);
    eq(g.order, i);
    eq(g.comparator, g.metric === 'spend' ? 'lte' : 'gte');
  });
});

test('formatMetricValue', () => {
  eq(M.formatMetricValue('water', 6), '6 glasses');
  eq(M.formatMetricValue('water', 1), '1 glass');
  eq(M.formatMetricValue('trainingMinutes', 80), '1h 20m');
  eq(M.formatMetricValue('reflection', 1), 'Done');
  eq(M.formatMetricValue('sleep', 7.5), '7.5 h');
  eq(M.formatMetricValue('protein', 75), '75 g');
  eq(M.formatMetricValue('water', null), '—');
});

// ------------------------------------------------------------------------------------------- backup
group('backup');

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1, 2]);

async function seedBackupData() {
  await resetStores();
  await updateSettings({ onboarded: true, name: 'Alex', currency: 'INR' });
  await seedMetricsDay(); // resets again → re-apply settings after
  await updateSettings({ onboarded: true, name: 'Alex', currency: 'INR' });
  await db.put('files', { id: 'img1', blob: new Blob([PNG_BYTES], { type: 'image/png' }), type: 'image/png' });
  await db.put('goals', { id: 'g1', title: 'Water', kind: 'metric', metric: 'water', comparator: 'gte', target: 8, active: true, order: 0 });
  await db.put('reviews', { id: 'week:2026-W48', type: 'week', period: '2026-W48', rating: 4, wentWell: 'Consistent', improve: '', focus: '' });
  await db.put('workouts', { date: DAY, time: '19:00', type: 'strength', title: 'Push day', duration: 50, exercises: [{ name: 'Bench press', sets: [{ reps: 8, weight: 60 }, { reps: 8, weight: 60 }, { reps: 8, weight: 60 }] }, { name: 'Dips', sets: [{ reps: 12 }, { reps: 10 }] }] });
}

async function countAll() {
  const out = {};
  for (const s of STORES) out[s] = await db.count(s);
  return out;
}

test('exportAll includes every store; files become data URLs', async () => {
  await seedBackupData();
  const data = await B.exportAll();
  eq(data.app, 'daybook');
  eq(data.schema, 1);
  assert(!Number.isNaN(Date.parse(data.exportedAt)), 'exportedAt ISO');
  eq(Object.keys(data.stores).sort(), [...STORES].sort());
  const f = data.stores.files[0];
  eq(f.id, 'img1');
  eq(f.type, 'image/png');
  assert(f.dataUrl.startsWith('data:image/png;base64,'), 'dataUrl');
  assert(!('blob' in f) && f.createdAt, 'no blob, has createdAt');
  eq(JSON.parse(JSON.stringify(data)).stores.food.length, 2, 'JSON-serialisable');
  eq(data.stores.meta.find((m) => m.key === 'settings').value.currency, 'INR');
});

test('roundtrip: export → clearAllData → import(replace) restores everything', async () => {
  await seedBackupData();
  const before = await countAll();
  const data = await B.exportAll();
  const text = JSON.stringify(data);
  const ev = capture('db:change');
  await B.clearAllData();
  eq(Object.values(await countAll()).every((n) => n === 0), true, 'all stores empty');
  eq(getSettings().onboarded, false, 'settings reset to defaults');
  eq(ev.list.at(-1).store, '*');
  eq(ev.list.at(-1).op, 'clear');
  const sev = capture('settings:change');
  const counts = await B.importBackup(new File([text], 'daybook-backup.json', { type: 'application/json' }), { mode: 'replace' });
  sev.off();
  ev.off();
  eq(counts, before, 'returned counts = original counts');
  eq(await countAll(), before, 'db counts restored');
  eq(getSettings().onboarded, true, 'settings restored + reloaded');
  eq(getSettings().currency, 'INR');
  eq(ev.list.at(-1).store, '*');
  eq(ev.list.at(-1).op, 'import');
  eq(sev.list.length, 1, 'settings:change emitted');
  const file = await db.get('files', 'img1');
  assert(file.blob instanceof Blob, 'blob restored');
  eq(file.blob.type, 'image/png');
  eq([...new Uint8Array(await file.blob.arrayBuffer())], [...PNG_BYTES], 'bytes identical');
  const food = await db.all('food');
  eq(food.map((f) => f.title), ['Oats', 'Dal rice']);
  eq(food[0].updatedAt, data.stores.food.find((f) => f.title === 'Oats').updatedAt, 'timestamps preserved');
  const m = await M.getDayMetrics(DAY);
  eq([m.tradePnl, m.spend, m.water], [75, 350, 8], 'metrics identical after restore');
});

test('replace clears records that are not in the backup', async () => {
  const data = await B.exportAll();
  await db.put('food', { id: 'extra', date: DAY, title: 'Not in backup' });
  await B.importBackup(data, { mode: 'replace' });
  eq(await db.get('food', 'extra'), undefined);
});

test('merge keeps the newer updatedAt, adds missing, keeps current settings', async () => {
  await resetStores();
  await updateSettings({ onboarded: true, currency: 'INR' });
  await db.put('food', { id: 'X', date: DAY, title: 'local newer', updatedAt: '2026-01-02T00:00:00.000Z' }, { touch: false });
  await db.put('food', { id: 'Y', date: DAY, title: 'local older', updatedAt: '2026-01-01T00:00:00.000Z' }, { touch: false });
  await db.put('days', { date: DAY, water: 5, updatedAt: '2026-01-03T00:00:00.000Z' }, { touch: false });
  await db.put('files', { id: 'imgA', blob: new Blob(['local'], { type: 'text/plain' }), type: 'text/plain' });
  const backup = {
    app: 'daybook',
    schema: 1,
    exportedAt: new Date().toISOString(),
    stores: {
      food: [
        { id: 'X', date: DAY, title: 'backup older', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'Y', date: DAY, title: 'backup newer', updatedAt: '2026-01-05T00:00:00.000Z' },
        { id: 'Z', date: DAY, title: 'backup only', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      days: [{ date: DAY, water: 1, updatedAt: '2026-01-01T00:00:00.000Z' }],
      files: [
        { id: 'imgA', type: 'text/plain', dataUrl: 'data:text/plain;base64,' + btoa('backup'), createdAt: null },
        { id: 'imgB', type: 'text/plain', dataUrl: 'data:text/plain,hello%20there', createdAt: null },
      ],
      meta: [
        {
          key: 'settings',
          value: deepMerge(DEFAULT_SETTINGS, {
            onboarded: true,
            currency: 'USD',
            expenseCategories: [...DEFAULT_SETTINGS.expenseCategories, { id: 'pets', name: 'Pets', emoji: '🐶', color: '#a16207', budget: 0 }],
            trading: { setups: ['Breakout', 'Opening range'] },
          }),
        },
      ],
      bogus: [{ id: 1 }],
    },
  };
  const counts = await B.importBackup(backup, { mode: 'merge' });
  const byId = Object.fromEntries((await db.all('food')).map((f) => [f.id, f.title]));
  eq(byId, { X: 'local newer', Y: 'backup newer', Z: 'backup only' });
  eq(counts.food, 2);
  eq(counts.days, 0, 'older day ignored');
  eq((await db.getDay(DAY)).water, 5);
  eq(counts.files, 1, 'only the missing file is added');
  eq(await (await db.get('files', 'imgA')).blob.text(), 'local');
  eq(await (await db.get('files', 'imgB')).blob.text(), 'hello there', 'non-base64 data URL');
  const s = getSettings();
  eq(s.currency, 'INR', 'current settings kept');
  assert(s.expenseCategories.some((c) => c.id === 'pets'), 'missing category appended');
  eq(s.expenseCategories.length, 15);
  assert(s.trading.setups.includes('Opening range') && s.trading.setups.length === DEFAULT_SETTINGS.trading.setups.length + 1, 'setups union');
});

test('merge into a fresh (not onboarded) app takes the backup settings', async () => {
  await B.clearAllData();
  eq(getSettings().onboarded, false);
  await B.importBackup(
    { app: 'daybook', schema: 1, stores: { meta: [{ key: 'settings', value: { onboarded: true, currency: 'EUR', name: 'Sam' } }] } },
    { mode: 'merge' },
  );
  eq([getSettings().onboarded, getSettings().currency, getSettings().name], [true, 'EUR', 'Sam']);
  eq(getSettings().targets.water, 8, 'defaults filled in');
});

test('invalid backups are rejected and nothing changes', async () => {
  const before = await countAll();
  await rejects(B.importBackup({ app: 'other', stores: {} }), 'wrong app');
  await rejects(B.importBackup({ app: 'daybook', stores: [] }), 'stores array');
  await rejects(B.importBackup({ app: 'daybook' }), 'no stores');
  await rejects(B.importBackup('not json {'), 'bad JSON');
  await rejects(B.importBackup(new Blob(['{"app":"x"}'])), 'blob with wrong app');
  await rejects(B.importBackup(null), 'null');
  await rejects(B.importBackup({ app: 'daybook', schema: 99, stores: {} }), 'newer schema');
  const err = await rejects(B.importBackup({ app: 'nope', stores: {} }));
  assert(/backup/i.test(err.message), 'friendly message');
  eq(await countAll(), before, 'unchanged');
});

test('toCSV: RFC 4180 quoting, arrays, formula guard', () => {
  const csv = B.toCSV(
    [
      { a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: null, e: ['t1', 't2'], f: 5, g: true },
      { a: '=SUM(A1)', b: '-5', c: ' padded', d: undefined, e: [], f: -2.5, g: false },
    ],
    [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B "quoted"' },
      { key: 'c', label: 'C' },
      { key: 'd', label: 'D' },
      { key: 'e', label: 'E' },
      { value: (r) => r.f * 2, label: 'F2' },
      'g',
    ],
  );
  const lines = csv.split('\r\n');
  eq(lines[0], 'A,"B ""quoted""",C,D,E,F2,g');
  eq(lines[1], '"x,y","say ""hi""","line1\nline2",,t1; t2,10,Yes');
  eq(lines.length, 3, 'CRLF separators (embedded \\n stays inside quotes)');
  eq(lines[2], "'=SUM(A1),-5,\" padded\",,,-5,No");
  eq(B.toCSV([], [{ key: 'a', label: 'A' }]), 'A');
});

test('exportCSV: human-friendly per-store columns', async () => {
  await seedBackupData();
  const ex = await B.exportCSV('expenses', { download: false });
  const exLines = ex.csv.split('\r\n');
  eq(exLines[0], 'Date,Time,Type,Category,Amount (INR),Method,Note,Tags');
  eq(exLines[1], `${DAY},09:00,Expense,Food & dining,250,,,`);
  eq(ex.count, 3);
  assert(exLines[3].includes('Income,Salary,5000'), 'income row');
  const tr = await B.exportCSV('trades', { from: DAY, to: DAY, download: false });
  const head = tr.csv.split('\r\n')[0].split(',');
  const row = tr.csv.split('\r\n')[1].split(',');
  eq(row[head.indexOf('Symbol')], 'NIFTY');
  eq(row[head.indexOf('Net P&L (INR)')], '95');
  eq(row[head.indexOf('Gross P&L (INR)')], '100');
  eq(row[head.indexOf('R multiple')], '1.9');
  eq(tr.filename, `daybook-trades-${DAY}.csv`);
  const wk = await B.exportCSV('workouts', { download: false });
  assert(wk.csv.includes('Bench press 3×8 @ 60 kg; Dips 12, 10'), wk.csv);
  const food = await B.exportCSV('food', { download: false });
  assert(food.csv.split('\r\n')[1].includes('Breakfast,Oats,600,30,80,12'), food.csv);
  const learn = await B.exportCSV('learning', { download: false });
  assert(learn.csv.includes('Kelly criterion'), 'learning');
  const month = await B.exportCSV('expenses', { from: D.startOfMonth(DAY), to: D.endOfMonth(DAY), download: false });
  eq(month.filename, `daybook-expenses-${D.monthOf(DAY)}.csv`);
  await rejects(B.exportCSV('nope', { download: false }), 'unknown store');
});

test('downloadText / downloadBackup use an <a download> and revoke the URL', async () => {
  const clicks = [];
  const revoked = [];
  const origClick = HTMLAnchorElement.prototype.click;
  const origRevoke = URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function () {
    clicks.push({ href: this.href, download: this.download });
  };
  URL.revokeObjectURL = (u) => {
    revoked.push(u);
    origRevoke.call(URL, u);
  };
  try {
    B.downloadText('hello.txt', 'hi', 'text/plain');
    eq(clicks.length, 1);
    eq(clicks[0].download, 'hello.txt');
    assert(clicks[0].href.startsWith('blob:'), 'blob URL');
    const before = getSettings().lastBackupAt;
    const res = await B.downloadBackup();
    eq(res.filename, `daybook-backup-${TODAY}.json`);
    eq(clicks.at(-1).download, res.filename);
    assert(getSettings().lastBackupAt && getSettings().lastBackupAt !== before, 'lastBackupAt updated');
    await sleep(1700);
    assert(revoked.includes(clicks[0].href) && revoked.includes(clicks[1].href), 'object URLs revoked');
    assert(!document.querySelector('a[download]'), 'anchors removed');
  } finally {
    HTMLAnchorElement.prototype.click = origClick;
    URL.revokeObjectURL = origRevoke;
  }
});

test('shareBackup: Web Share when files can be shared, else download', async () => {
  const origClick = HTMLAnchorElement.prototype.click;
  const clicks = [];
  HTMLAnchorElement.prototype.click = function () {
    clicks.push(this.download);
  };
  const desc = (k) => Object.getOwnPropertyDescriptor(navigator, k);
  const saved = { share: desc('share'), canShare: desc('canShare') };
  const shared = [];
  try {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => d.files[0].type === 'application/json' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => shared.push(d) });
    const r1 = await B.shareBackup();
    eq(r1.method, 'share');
    eq(shared[0].files[0].name, `daybook-backup-${TODAY}.json`);
    // Android-style: json refused, text accepted
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => d.files[0].type === 'text/plain' });
    const r2 = await B.shareBackup();
    eq([r2.method, r2.filename], ['share', `daybook-backup-${TODAY}.txt`]);
    // user cancels
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('cancel', 'AbortError'); } });
    eq((await B.shareBackup()).method, 'cancelled');
    // not allowed → falls back to download
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('no', 'NotAllowedError'); } });
    eq((await B.shareBackup()).method, 'download');
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    eq((await B.shareBackup()).method, 'download');
    eq(clicks.length, 2);
  } finally {
    HTMLAnchorElement.prototype.click = origClick;
    for (const k of ['share', 'canShare']) {
      if (saved[k]) Object.defineProperty(navigator, k, saved[k]);
      else delete navigator[k];
    }
  }
});

// --------------------------------------------------------------------------------------------- calc
group('trades/calc.js');

const T = (o) => C.prepareTrade({ symbol: 'x', entryDate: '2026-11-02', status: 'closed', quantity: 10, ...o });

test('gross / net / fees for long and short', () => {
  const long = T({ direction: 'long', entryPrice: 100, exitPrice: 110, fees: 5 });
  eq(C.tradeGross(long), 100);
  eq(C.tradeNet(long), 95);
  const short = T({ direction: 'short', entryPrice: 100, exitPrice: 90 });
  eq(C.tradeGross(short), 100);
  eq(C.tradeNet(short), 100);
  const shortLoss = T({ direction: 'short', entryPrice: 100, exitPrice: 104, fees: 2 });
  eq(C.tradeNet(shortLoss), -42);
  const lot = T({ direction: 'long', entryPrice: 22000, exitPrice: 22050, quantity: 2, multiplier: 25 });
  eq(C.tradeGross(lot), 2500, 'multiplier');
  eq(C.tradeNet(T({ entryPrice: 0.1, exitPrice: 0.3, quantity: 1 })), 0.2, 'float noise rounded');
  eq(C.tradeNet(C.prepareTrade({ status: 'open', entryPrice: 1, quantity: 1 })), null, 'open → null');
});

test('override, R, plannedRR, return %, outcome', () => {
  const o = T({ entryPrice: 100, exitPrice: 110, fees: 5, pnlOverride: -12 });
  eq(C.tradeNet(o), -12);
  eq(C.outcome(o), 'loss');
  const r = T({ entryPrice: 100, exitPrice: 110, fees: 5, stopLoss: 95, target: 115 });
  eq(C.tradeRisk(r), 50);
  approx(C.tradeR(r), 1.9);
  approx(C.plannedRR(r), 3);
  approx(C.tradeReturnPct(r), 0.095);
  const s = T({ direction: 'short', entryPrice: 100, exitPrice: 98, stopLoss: 104, target: 90 });
  approx(C.tradeR(s), 0.5);
  approx(C.plannedRR(s), 2.5);
  eq(C.tradeRisk(T({ entryPrice: 100, exitPrice: 101, stopLoss: 105 })), null, 'stop on the wrong side');
  eq(C.outcome(T({ entryPrice: 100, exitPrice: 100 })), 'breakeven');
  eq(C.outcome(C.prepareTrade({ status: 'open' })), 'open');
});

test('prepareTrade normalises fields and index date', () => {
  const t = C.prepareTrade({ symbol: ' nifty ', status: 'closed', entryDate: '2026-11-02', exitDate: '2026-11-04', entryPrice: '100', exitPrice: '1,010', quantity: '2', fees: '' });
  eq([t.symbol, t.direction, t.entryPrice, t.exitPrice, t.fees, t.multiplier, t.date], ['NIFTY', 'long', 100, 1010, 0, 1, '2026-11-04']);
  const open = C.prepareTrade({ status: 'open', entryDate: '2026-11-02', exitPrice: 5, pnlOverride: 3 });
  eq([open.exitPrice, open.pnlOverride, open.date], [null, null, '2026-11-02']);
  eq(C.prepareTrade({ status: 'closed', entryDate: '2026-11-02' }).exitDate, '2026-11-02');
});

test('computeStats: win rate, profit factor (incl. Infinity), drawdown, streaks', () => {
  const seq = (pnls) =>
    pnls.map((p, i) => T({ entryPrice: 100, exitPrice: 100 + p / 10, entryTime: `09:${String(10 + i).padStart(2, '0')}`, exitTime: `10:${String(10 + i).padStart(2, '0')}` }));
  const s = C.computeStats(seq([100, -50, -30, 200]));
  eq(s.count, 4);
  eq([s.wins, s.losses], [2, 2]);
  approx(s.winRate, 0.5);
  approx(s.net, 220);
  approx(s.profitFactor, 300 / 80);
  approx(s.maxDrawdown, 80);
  eq([s.maxWinStreak, s.maxLossStreak], [1, 2]);
  eq(s.currentStreak, { type: 'win', count: 1 });
  approx(s.expectancy, 55);
  approx(s.avgWin, 150);
  approx(s.avgLoss, 40);
  eq(C.tradeNet(s.best), 200);
  eq(C.tradeNet(s.worst), -50);
  const allWins = C.computeStats(seq([10, 20]));
  eq(allWins.profitFactor, Infinity);
  eq(allWins.maxDrawdown, 0);
  const none = C.computeStats([]);
  eq([none.count, none.winRate, none.profitFactor], [0, null, null]);
  const withOpen = C.computeStats([...seq([10]), C.prepareTrade({ status: 'open', entryDate: '2026-11-02' })]);
  eq([withOpen.count, withOpen.open], [1, 1]);
  const losses = C.computeStats(seq([-10, -20, -5]));
  eq(losses.currentStreak, { type: 'loss', count: 3 });
  approx(losses.maxDrawdown, 35);
});

test('equitySeries / dailyPnl / groupStats / rDistribution', () => {
  const a = T({ entryDate: '2026-11-02', entryTime: '09:30', exitTime: '10:00', entryPrice: 100, exitPrice: 110, stopLoss: 95, setup: 'Breakout' });
  const b = T({ entryDate: '2026-11-03', entryTime: '09:30', exitTime: '10:00', entryPrice: 100, exitPrice: 97, stopLoss: 95, setup: 'Pullback', mistakes: ['FOMO entry'] });
  const eqs = C.equitySeries([b, a], { start: 1000 });
  eq(eqs.map((p) => p.equity), [1100, 1070]);
  eq(eqs[1].drawdown, 30);
  const daily = C.dailyPnl([a, b]);
  eq(daily['2026-11-02'], { pnl: 100, count: 1, wins: 1, losses: 0 });
  const g = C.groupStats([a, b], (t) => t.setup);
  eq(g.map((x) => x.key), ['Breakout', 'Pullback']);
  const gm = C.groupStats([a, b], (t) => t.mistakes, { emptyLabel: 'None' });
  eq(gm.map((x) => x.key).sort(), ['FOMO entry', 'None']);
  const dist = C.rDistribution([a, b]);
  eq(dist.reduce((n, x) => n + x.count, 0), 2);
  eq(dist.find((x) => x.from === 2 && x.to === 3).count, 1, '+2R bucket');
  eq(dist.find((x) => x.from === -1 && x.to === 0).count, 1, '−0.6R bucket');
});

// ------------------------------------------------------------------------------------- connection
group('connection');

test('versionchange from another tab closes our connection gracefully', async () => {
  await openDB();
  const ev = capture('db:versionchange');
  const other = await new Promise((resolve, reject) => {
    const req = indexedDB.open('daybook', 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked: our connection did not close on versionchange'));
  });
  ev.off();
  eq(other.version, 2);
  eq(ev.list.length, 1, 'db:versionchange emitted');
  other.close();
  // A newer schema now exists, so the app must report an error (not hang) on its next call.
  const err = await rejects(withTimeout(db.count('food'), 4000, 'reopen after upgrade'), 'VersionError surfaces as a rejection');
  assert(!(err instanceof AssertionError), `rejected rather than hanging (${err.message})`);
  eq(err.name, 'VersionError');
  await new Promise((resolve) => {
    const del = indexedDB.deleteDatabase('daybook');
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
});

// ===================================================================================================
// Runner

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('daybook');
    const t = setTimeout(() => reject(new Error('deleteDatabase blocked — close other Daybook tabs on this origin')), 5000);
    req.onsuccess = () => {
      clearTimeout(t);
      resolve();
    };
    req.onerror = () => {
      clearTimeout(t);
      reject(req.error);
    };
  });
}

async function run() {
  const t0 = performance.now();
  try {
    await deleteDatabase();
    try {
      localStorage.removeItem('daybook.theme');
    } catch {
      /* ignore */
    }
  } catch (err) {
    results.push({ group: 'setup', name: 'delete IndexedDB "daybook"', ok: false, error: String(err && err.message), ms: 0 });
    renderResult(results[0]);
  }
  for (const t of queue) {
    const s = performance.now();
    let ok = true;
    let error = '';
    try {
      await withTimeout(Promise.resolve().then(t.fn), 15000, t.name);
    } catch (err) {
      ok = false;
      error = (err && (err instanceof AssertionError ? err.message : `${err.name}: ${err.message}\n${err.stack || ''}`)) || String(err);
    }
    const r = { group: t.group, name: t.name, ok, error, ms: Math.round(performance.now() - s) };
    results.push(r);
    renderResult(r);
  }
  const failures = results.filter((r) => !r.ok);
  const passed = results.length - failures.length;
  const ms = performance.now() - t0;
  renderSummary(passed, failures.length, ms);
  window.__testResults = {
    passed,
    failed: failures.length,
    failures: failures.map((f) => ({ group: f.group, name: f.name, error: f.error })),
    total: results.length,
    ms: Math.round(ms),
  };
  window.__testsDone = true;
  document.title = `${failures.length ? '✗' : '✓'} ${passed}/${results.length} · Daybook core tests`;
}

run();
