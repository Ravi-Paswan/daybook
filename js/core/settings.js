// Settings store (SPEC 3.3).
// - Stored settings live in meta {key:'settings', value}. loadSettings() deep-merges them over
//   DEFAULT_SETTINGS (plain objects merge; arrays from storage REPLACE the defaults).
// - getSettings() is sync and returns the cached object — treat it as read-only. Before loadSettings()
//   has run it returns a copy of the defaults, so formatters work in tests/early boot.
// - updateSettings(patch) deep-merges, persists the full object and emits 'settings:change' {settings, patch}.
// - settings.theme is mirrored to localStorage 'daybook.theme' (the shell reads it before first paint).
// Must NOT import metrics.js / backup.js / dates.js / format.js (avoids import cycles).

import { db, deepMerge, clone } from './db.js';
import { emit } from './bus.js';

const cat = (id, name, emoji, color, extra = {}) => ({ id, name, emoji, color, ...extra });

export const DEFAULT_SETTINGS = {
  onboarded: false,
  name: '',
  currency: 'USD',
  theme: 'system', // 'light' | 'dark' | 'system'
  weekStart: 1, // 0 Sun, 1 Mon
  units: { weight: 'kg', distance: 'km' },
  targets: {
    calories: 2200,
    protein: 100,
    water: 8,
    glassMl: 250,
    trainingMinutes: 30,
    weeklyTrainingMinutes: 150,
    sleep: 8,
    steps: 8000,
    dailySpend: 0,
    monthlyBudget: 0,
  },
  expenseCategories: [
    cat('food', 'Food & dining', '🍽️', '#f97316', { budget: 0 }),
    cat('groceries', 'Groceries', '🛒', '#65a30d', { budget: 0 }),
    cat('transport', 'Transport', '🚕', '#eab308', { budget: 0 }),
    cat('bills', 'Bills & utilities', '💡', '#0891b2', { budget: 0 }),
    cat('rent', 'Rent', '🏠', '#7c3aed', { budget: 0 }),
    cat('shopping', 'Shopping', '🛍️', '#ec4899', { budget: 0 }),
    cat('health', 'Health', '💊', '#ef4444', { budget: 0 }),
    cat('entertainment', 'Entertainment', '🎬', '#c026d3', { budget: 0 }),
    cat('education', 'Education', '📚', '#2563eb', { budget: 0 }),
    cat('fitness', 'Fitness', '🏋️', '#10b981', { budget: 0 }),
    cat('travel', 'Travel', '✈️', '#0ea5e9', { budget: 0 }),
    cat('gifts', 'Gifts', '🎁', '#fb7185', { budget: 0 }),
    cat('subscriptions', 'Subscriptions', '🔁', '#6366f1', { budget: 0 }),
    cat('other', 'Other', '📦', '#94a3b8', { budget: 0 }),
  ],
  incomeCategories: [
    cat('salary', 'Salary', '💼', '#10b981'),
    cat('freelance', 'Freelance', '🧑‍💻', '#3b82f6'),
    cat('business', 'Business', '🏪', '#f59e0b'),
    cat('trading', 'Trading', '📈', '#6366f1'),
    cat('interest', 'Interest', '🏦', '#14b8a6'),
    cat('gift', 'Gift', '🎁', '#ec4899'),
    cat('other', 'Other', '💰', '#94a3b8'),
  ],
  paymentMethods: ['Cash', 'UPI', 'Card', 'Bank', 'Wallet'],
  learningCategories: [
    cat('tech', 'Tech', '💻', '#3b82f6'),
    cat('trading', 'Trading & markets', '📈', '#6366f1'),
    cat('finance', 'Finance', '💰', '#10b981'),
    cat('health', 'Health', '🫀', '#ef4444'),
    cat('business', 'Business', '🚀', '#f97316'),
    cat('language', 'Language', '🗣️', '#eab308'),
    cat('science', 'Science', '🔬', '#06b6d4'),
    cat('growth', 'Personal growth', '🌱', '#84cc16'),
    cat('skills', 'Skills', '🛠️', '#a855f7'),
    cat('other', 'Other', '✨', '#94a3b8'),
  ],
  workoutTypes: [
    cat('strength', 'Strength', '🏋️', '#f97316'),
    cat('cardio', 'Cardio', '🏃', '#ef4444'),
    cat('hiit', 'HIIT', '⚡', '#eab308'),
    cat('yoga', 'Yoga', '🧘', '#a855f7'),
    cat('sports', 'Sports', '⚽', '#3b82f6'),
    cat('walk', 'Walk', '🚶', '#10b981'),
    cat('mobility', 'Mobility', '🤸', '#06b6d4'),
    cat('other', 'Other', '💪', '#94a3b8'),
  ],
  trading: {
    currency: null, // null → use app currency
    accounts: [{ id: 'main', name: 'Main account', broker: '', startingBalance: 0 }],
    defaultAccountId: 'main',
    markets: ['stocks', 'options', 'futures', 'forex', 'crypto', 'commodities', 'other'],
    setups: ['Breakout', 'Pullback', 'Reversal', 'Trend follow', 'Range', 'Gap & go', 'News', 'Scalp'],
    mistakes: [
      'FOMO entry',
      'No stop loss',
      'Moved stop',
      'Oversized',
      'Revenge trade',
      'Early exit',
      'Late entry',
      'Overtrading',
      'Ignored plan',
      'Chased price',
    ],
    emotions: ['Calm', 'Confident', 'Focused', 'Anxious', 'Fearful', 'Greedy', 'Impatient', 'Frustrated', 'Bored', 'Euphoric'],
    tags: [],
    rules: [
      { id: 'r1', text: 'Always place a stop loss' },
      { id: 'r2', text: 'Risk at most 1% per trade' },
      { id: 'r3', text: 'No trades in the first 15 minutes' },
      { id: 'r4', text: 'Stop after 3 losses in a day' },
    ],
    riskPercent: 1,
  },
  lastBackupAt: null,
  backupReminderDays: 7,
};

const THEME_KEY = 'daybook.theme';

let cache = clone(DEFAULT_SETTINGS);
let loaded = false;

function mirrorTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme || 'system');
  } catch {
    /* storage blocked (private mode / sandbox) — the shell falls back to 'system' */
  }
}

/** Called once at boot (and after import / clear-all). Deep-merges stored over defaults. */
export async function loadSettings() {
  let stored = null;
  try {
    stored = await db.getMeta('settings', null);
  } catch (err) {
    console.warn('[daybook] could not read settings, using defaults', err);
  }
  cache = deepMerge(clone(DEFAULT_SETTINGS), stored && typeof stored === 'object' ? stored : {});
  loaded = true;
  mirrorTheme(cache.theme);
  return cache;
}

/** Sync; the cached settings object. Do not mutate — use updateSettings(). */
export function getSettings() {
  return cache;
}

export function isSettingsLoaded() {
  return loaded;
}

/** Deep-merge `patch` (arrays replace), persist, emit 'settings:change'. → new settings object. */
export async function updateSettings(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const prev = cache;
  const next = deepMerge(cache, p);
  cache = next; // sequential calls build on each other even before the write lands
  mirrorTheme(next.theme);
  try {
    await db.setMeta('settings', next);
  } catch (err) {
    if (cache === next) {
      cache = prev; // nothing newer was applied on top — roll back
      mirrorTheme(prev.theme);
    }
    throw err;
  }
  emit('settings:change', { settings: next, patch: p });
  return next;
}

// ---------------------------------------------------------------------------------------------------
// Lookups — always return an object (fallback for unknown / deleted ids).

function lookup(list, id, base) {
  const arr = Array.isArray(list) ? list : [];
  const found = arr.find((c) => c && c.id === id);
  if (found) return found;
  const other = arr.find((c) => c && c.id === 'other');
  return { ...base, ...(other || {}), id: id ?? 'other', missing: true };
}

export function expenseCategory(id) {
  return lookup(cache.expenseCategories, id, { name: 'Other', emoji: '📦', color: '#94a3b8', budget: 0 });
}

export function incomeCategory(id) {
  return lookup(cache.incomeCategories, id, { name: 'Other', emoji: '💰', color: '#94a3b8' });
}

/** Expense or income category depending on the record type. */
export function moneyCategory(type, id) {
  return type === 'income' ? incomeCategory(id) : expenseCategory(id);
}

export function learningCategory(id) {
  return lookup(cache.learningCategories, id, { name: 'Other', emoji: '✨', color: '#94a3b8' });
}

export function workoutType(id) {
  return lookup(cache.workoutTypes, id, { name: 'Other', emoji: '💪', color: '#94a3b8' });
}

export function tradingAccount(id) {
  const t = cache.trading || {};
  const list = Array.isArray(t.accounts) ? t.accounts : [];
  const key = id || t.defaultAccountId || 'main';
  const found = list.find((a) => a && a.id === key);
  if (found) return found;
  return {
    id: key,
    name: key === 'main' ? 'Main account' : String(key),
    broker: '',
    startingBalance: 0,
    missing: true,
  };
}
