# Daybook — Product & Engineering Spec

Daybook is an offline-first, installable (PWA) personal journal for **daily goals** (food, learning,
training, expenses, mood/reflection) and **trade journaling**. It runs on phone and desktop from one
codebase, with no build step and no dependencies. All data is stored on-device in IndexedDB; backup/restore
moves data between devices.

This document is the contract every contributor codes against. **Read it fully before writing code.**
If something you need is not specified, pick the simplest option consistent with this spec and note it
at the top of your file in a short comment.

---------------------------------------------------------------------------------------------------------

## 0. Hard rules (apply to every file)

1. **Plain modern JavaScript ES modules** (`import`/`export`), no TypeScript, no JSX, no bundler, no npm,
   no CDN libraries. Everything is vanilla JS + CSS + inline SVG. Target: current Chrome, Edge, Safari
   (iOS 16.4+), Firefox, Samsung Internet.
2. **Relative imports with explicit `.js` extensions** (`import { db } from '../core/db.js'`).
   Never absolute `/js/...` paths (the app must work when hosted in a sub-folder, e.g. GitHub Pages).
3. **Never put user content into `innerHTML`.** Build DOM with `h()` from `js/core/ui.js` (it uses
   `textContent`). The only allowed `innerHTML` is trusted static SVG markup from `icons.js` / `charts.js`.
4. **Dates are local-time keys** `'YYYY-MM-DD'` (string). Never derive a date key from
   `Date.prototype.toISOString()` (that is UTC and shifts the day). Use `js/core/dates.js`.
   Times are `'HH:MM'` 24h strings. Months are `'YYYY-MM'`.
5. **Percentages are fractions** in code (`0.523`), formatted with `fmtPercent()` → `"52.3%"`.
6. **Money/amounts are plain numbers** in the app currency (`settings.currency`); format with `fmtMoney()`.
7. **No `alert/confirm/prompt`.** Use `confirmDialog()`, `toast()`, `openSheet()` from `ui.js`.
8. Every view `render()` must **clean up** what it registers (bus listeners, timers, window listeners) by
   returning a cleanup function.
9. Accessibility: every input has a label (`field()`), buttons are `<button>`, icon-only buttons have
   `aria-label`, focus is visible, tap targets ≥ 44px, color is never the only signal (P&L also has a
   sign: `+₹1,200` / `−₹300`).
10. Inputs use `font-size: 16px` minimum (prevents iOS zoom). Numeric inputs:
    `type="number" step="any" inputmode="decimal"`.
11. Only touch the files you are assigned. If you believe a shared/core file has a bug, work around it in
    your own file and report the bug in your final message (exact file, line, and fix).
12. Keep the UI copy short, friendly and human. Empty states always offer the next action.

---------------------------------------------------------------------------------------------------------

## 1. File layout

```
daybook/
  index.html                  app shell markup, links ALL css files, loads js/app.js (module)
  manifest.webmanifest        PWA manifest
  sw.js                       service worker (offline cache)
  start.bat                   Windows: run local server + open browser
  README.md
  docs/SPEC.md                this file
  assets/icons/               icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png, favicon-32.png
  css/tokens.css              design tokens (colors, radii, shadows, type scale) light + dark
  css/base.css                reset, typography, app shell layout (sidebar, topbar, bottom nav, FAB)
  css/components.css          shared component classes (section 6)
  css/charts.css              chart + tooltip styles
  css/modules/<name>.css      one per module (today, food, learning, training, expenses, trades,
                              trades-analytics, goals, calendar, insights, search, settings, onboarding)
  js/app.js                   boot, shell, nav, router wiring, quick-add, SW registration, theme
  js/core/db.js               IndexedDB wrapper
  js/core/bus.js              event bus + shared app state
  js/core/settings.js         settings store + DEFAULT_SETTINGS
  js/core/router.js           hash router
  js/core/ui.js               DOM helper h() + UI components
  js/core/undo.js             removeWithUndo()
  js/core/dates.js            date utilities
  js/core/format.js           number / money / duration formatting
  js/core/charts.js           SVG charts
  js/core/icons.js            SVG icon set
  js/core/metrics.js          per-day metrics + goals evaluation + streaks
  js/core/images.js           image compression / storage / lightbox
  js/core/backup.js           export/import JSON, CSV export, share
  js/modules/registry.js      module loader (already written — do not edit)
  js/modules/today.js         Today dashboard (home)
  js/modules/food.js
  js/modules/learning.js
  js/modules/training.js
  js/modules/expenses.js
  js/modules/trades/index.js      trades module entry: tabs + journal list
  js/modules/trades/calc.js       trade math (already written — do not edit)
  js/modules/trades/editor.js     trade add/edit sheet
  js/modules/trades/detail.js     single trade view
  js/modules/trades/analytics.js  analytics tab
  js/modules/trades/calendar.js   P&L calendar tab
  js/modules/trades/dayplan.js    pre-market plan / post-market review tab
  js/modules/goals.js
  js/modules/calendar.js      global calendar (day-score heatmap)
  js/modules/insights.js      weekly/monthly review across modules
  js/modules/search.js        global search
  js/modules/settings-view.js
  js/modules/onboarding.js    first-run welcome (route: welcome)
  js/modules/sample-data.js   deterministic demo data generator
  tools/serve.py              dev/static server with correct MIME types
  tools/smoke.py              headless-Chrome smoke tester (Playwright)
```

---------------------------------------------------------------------------------------------------------

## 2. Data model (IndexedDB)

DB name `daybook`, version `1`. Object stores:

| store      | keyPath | indexes                          | notes |
|------------|---------|----------------------------------|-------|
| `meta`     | `key`   | –                                | key/value; `{key:'settings', value:{...}}` |
| `days`     | `date`  | –                                | one record per day (water, mood, reflection, checks, trading plan) |
| `food`     | `id`    | `date`                           | meals |
| `learning` | `id`    | `date`, `nextReview`             | things learned |
| `workouts` | `id`    | `date`                           | training sessions |
| `expenses` | `id`    | `date`                           | expenses AND income |
| `trades`   | `id`    | `date`, `status`, `symbol`       | trade journal |
| `goals`    | `id`    | –                                | goal definitions |
| `reviews`  | `id`    | –                                | weekly / monthly reviews |
| `files`    | `id`    | –                                | image blobs `{id, blob, type, createdAt}` |

Common fields on `id` stores: `id` (string, `uid()`), `createdAt`, `updatedAt` (ISO strings, set by
`db.put`), optional `sample: true` (records created by the sample-data generator).

### 2.1 `days`
```js
{
  date: '2026-11-24',
  water: 0,                 // glasses
  mood: null,               // 1..5  (1 awful, 2 low, 3 okay, 4 good, 5 great)
  energy: null,             // 1..5
  sleep: null,              // hours (number, e.g. 7.5)
  weight: null,             // body weight in settings.units.weight
  steps: null,              // daily steps
  intention: '',            // morning: today's focus
  wins: '',                 // what went well
  reflection: '',           // free journal / lessons
  gratitude: '',
  checks: {},               // { [goalId]: true } for manual "check" goals
  trading: {                // per-day trading journal (see 4.6)
    bias: '',               // 'bullish' | 'bearish' | 'neutral' | ''
    watchlist: '',          // free text, key levels
    plan: '',               // game plan
    maxLoss: null,          // max loss allowed today (money)
    moodBefore: null,       // 1..5
    rulesChecked: {},       // { [ruleId]: true }
    review: '',             // post-market review
    lessons: '',
    grade: '',              // 'A'|'B'|'C'|'D'|'F'|''
  },
  updatedAt
}
```
`db.getDay(date)` always returns a full object with these defaults filled in (deep-merge), even if
nothing is stored. `db.patchDay(date, patch)` deep-merges `patch` (objects merged, arrays/primitives
replaced) into the stored day and saves it.

### 2.2 `food`
```js
{ id, date, time: 'HH:MM', meal: 'breakfast'|'lunch'|'dinner'|'snack',
  title: 'Oats with banana & peanut butter',   // what I ate (required)
  calories: null, protein: null, carbs: null, fat: null,   // optional numbers (kcal, g)
  quality: 'great'|'ok'|'poor'|null,           // healthy / balanced / junk
  photoId: null,                               // files store id
  note: '' }
```

### 2.3 `learning`
```js
{ id, date, title,                  // required
  takeaway: '',                     // one-line key insight
  notes: '',                        // longer notes (plain text, newlines kept)
  category: 'tech',                 // id from settings.learningCategories
  source: 'book'|'video'|'course'|'article'|'podcast'|'person'|'practice'|'experience'|'other',
  sourceName: '', link: '',
  minutes: null,
  tags: [],                         // lowercase strings
  starred: false,
  interval: 1,                      // spaced-repetition interval in days
  nextReview: 'YYYY-MM-DD',         // default: date + 1
  reviews: [] }                     // [{date, result:'again'|'hard'|'good'}]
```
Review scheduling (learning module): `again` → interval 1; `hard` → `max(1, round(interval*1.2))`;
`good` → `max(2, round(interval*2.5))`; then `nextReview = today + interval`.

### 2.4 `workouts`
```js
{ id, date, time, type,             // id from settings.workoutTypes (strength, cardio, hiit, yoga, sports, walk, mobility, other)
  title: '',                        // e.g. 'Push day', 'Evening run'
  duration: 45,                     // minutes (required, > 0)
  intensity: 7,                     // RPE 1..10 (nullable)
  calories: null, distance: null,   // kcal burned, distance in settings.units.distance
  exercises: [ { name: 'Bench press', sets: [ { reps: 8, weight: 60 } ] } ],
  feeling: null,                    // 1..5 how it felt
  notes: '' }
```
Body weight and steps live on the `days` record (`weight`, `steps`).

### 2.5 `expenses`
```js
{ id, date, time, type: 'expense'|'income',
  amount: 250,                      // positive number (required)
  category: 'food',                 // id from settings.expenseCategories / incomeCategories
  method: 'UPI',                    // one of settings.paymentMethods
  note: '', tags: [] }
```

### 2.6 `trades`
```js
{ id, accountId: 'main',
  symbol: 'NIFTY', market: 'stocks'|'options'|'futures'|'forex'|'crypto'|'commodities'|'other',
  direction: 'long'|'short',
  status: 'open'|'closed',
  entryDate, entryTime, exitDate, exitTime,
  date,                              // index date = closed ? (exitDate || entryDate) : entryDate  (set by prepareTrade)
  entryPrice, exitPrice, quantity,   // numbers (exitPrice null while open)
  multiplier: 1,                     // contract multiplier / lot size / point value
  fees: 0,                           // total commissions + taxes
  stopLoss: null, target: null,
  pnlOverride: null,                 // manual net P&L (spreads, complex options) — overrides calculation
  setup: '',                         // strategy name (settings.trading.setups)
  timeframe: '',                     // '1m','5m','15m','1h','4h','1D','1W' or ''
  confidence: null,                  // 1..5 before the trade
  rating: null,                      // 1..5 execution quality
  followedPlan: null,                // true | false | null
  emotions: [], mistakes: [], tags: [],
  thesis: '',                        // pre-trade reasoning
  review: '',                        // post-trade review / lessons
  screenshots: [] }                  // files store ids
```
All trade math lives in `js/modules/trades/calc.js` (already written). Always call
`prepareTrade(t)` before saving a trade.

### 2.7 `goals`
```js
{ id, title: 'Drink 8 glasses of water',
  kind: 'metric'|'check',            // metric = auto-evaluated from logs; check = manual daily checkbox
  metric: 'water',                   // key of METRICS (kind=metric only)
  comparator: 'gte'|'lte',           // value >= target  or  value <= target
  target: 8,
  icon: 'water', color: '--water',   // icon name from icons.js, CSS var name
  weekdays: null,                    // null = every day, or array of 0..6 (0 = Sunday)
  active: true, order: 0 }
```

### 2.8 `reviews`
```js
{ id: 'week:2026-W48' | 'month:2026-11', type: 'week'|'month', period: '2026-W48'|'2026-11',
  rating: null /*1..5*/, wentWell: '', improve: '', focus: '' }
```

---------------------------------------------------------------------------------------------------------

## 3. Core APIs (exact signatures)

### 3.1 `js/core/bus.js`
```js
export function on(event, fn)      // returns off()
export function emit(event, payload)
export const state = { date: todayKey() }   // "working date" (Today view sets it; quick-add uses it)
```
Events: `'db:change'` `{store, op:'put'|'delete'|'clear'|'import', key, record}` (store `'*'` after an
import/clear-all), `'settings:change'` `{settings, patch}`, `'route:change'` `{route}`,
`'state:date'` `{date}`.

### 3.2 `js/core/db.js`
```js
export function uid()                          // crypto.randomUUID() with fallback
export async function openDB()                 // idempotent; creates stores/indexes from section 2
export const db = {
  get(store, key),                             // → record | undefined
  put(store, record),                          // fills id/createdAt/updatedAt as applicable → saved record
  bulkPut(store, records),                     // one transaction; emits one 'db:change'
  delete(store, key),
  all(store),                                  // → array
  byDate(store, dateKey),                      // index 'date' == dateKey
  byRange(store, fromKey, toKey),              // inclusive, index 'date'; works for any store with a date index
  byIndex(store, indexName, value | IDBKeyRange),
  count(store),
  clear(store),
  getDay(date),                                // full defaults (2.1)
  patchDay(date, patch),                       // deep merge + save → saved day
  getMeta(key, fallback), setMeta(key, value),
};
export const STORES = [...]                    // names
```
Every write emits `'db:change'`. Results from `all/byDate/byRange` are sorted by `date` then `time`
then `createdAt` ascending.

### 3.3 `js/core/settings.js`
```js
export const DEFAULT_SETTINGS = {...}          // see 3.3.1
export async function loadSettings()           // called once at boot; deep-merges stored over defaults
export function getSettings()                  // sync, returns the cached object (do not mutate)
export async function updateSettings(patch)    // deep-merge, persist, emit 'settings:change'
export function expenseCategory(id)            // → category object or a fallback {id, name:'Other', emoji:'📦', color}
export function incomeCategory(id)
export function learningCategory(id)
export function workoutType(id)
export function tradingAccount(id)
```
#### 3.3.1 DEFAULT_SETTINGS (shape)
```js
{
  onboarded: false, name: '', currency: 'USD', theme: 'system' /*'light'|'dark'|'system'*/,
  weekStart: 1 /*0 Sun, 1 Mon*/, units: { weight: 'kg', distance: 'km' },
  targets: { calories: 2200, protein: 100, water: 8, glassMl: 250, trainingMinutes: 30,
             weeklyTrainingMinutes: 150, sleep: 8, steps: 8000, dailySpend: 0, monthlyBudget: 0 },
  expenseCategories: [ {id:'food', name:'Food & dining', emoji:'🍽️', color:'#f97316', budget:0},
     groceries 🛒, transport 🚕, bills 💡 (Bills & utilities), rent 🏠, shopping 🛍️, health 💊,
     entertainment 🎬, education 📚, fitness 🏋️, travel ✈️, gifts 🎁, subscriptions 🔁, other 📦 ],
  incomeCategories: [ salary 💼, freelance 🧑‍💻, business 🏪, trading 📈, interest 🏦, gift 🎁, other 💰 ],
  paymentMethods: ['Cash','UPI','Card','Bank','Wallet'],
  learningCategories: [ tech 💻, trading 📈 (Trading & markets), finance 💰, health 🫀, business 🚀,
     language 🗣️, science 🔬, growth 🌱 (Personal growth), skills 🛠️, other ✨ ],
  workoutTypes: [ strength 🏋️, cardio 🏃, hiit ⚡, yoga 🧘, sports ⚽, walk 🚶, mobility 🤸, other 💪 ],
  trading: {
    currency: null,                       // null → use app currency
    accounts: [ { id:'main', name:'Main account', broker:'', startingBalance: 0 } ],
    defaultAccountId: 'main',
    markets: ['stocks','options','futures','forex','crypto','commodities','other'],
    setups: ['Breakout','Pullback','Reversal','Trend follow','Range','Gap & go','News','Scalp'],
    mistakes: ['FOMO entry','No stop loss','Moved stop','Oversized','Revenge trade','Early exit',
               'Late entry','Overtrading','Ignored plan','Chased price'],
    emotions: ['Calm','Confident','Focused','Anxious','Fearful','Greedy','Impatient','Frustrated','Bored','Euphoric'],
    tags: [],
    rules: [ {id:'r1', text:'Always place a stop loss'}, {id:'r2', text:'Risk at most 1% per trade'},
             {id:'r3', text:'No trades in the first 15 minutes'}, {id:'r4', text:'Stop after 3 losses in a day'} ],
    riskPercent: 1,
  },
  lastBackupAt: null, backupReminderDays: 7,
}
```
(Each category object: `{id, name, emoji, color, budget?}`; colors are distinct, pleasant hex values.)

### 3.4 `js/core/router.js`
Hash routes: `#/<id>/<param1>/<param2>?a=b`.
```js
export function startRouter(onRoute)    // calls onRoute(route) on load and every hashchange
export function navigate(path, {replace=false}={})   // path like '/food' or '#/food' or '/trades/view/abc'
export function currentRoute()          // → { id, params: string[], query: Object, path }
```
Unknown / empty → `/today`. Route ids map to module `id`.

### 3.5 `js/core/ui.js`
```js
export function h(tag, props?, ...children)   // tag: 'div' | 'div.card.big' (class shorthand) | 'svg:path' (SVG ns)
   // props: class (string|array|{name:bool}), style (string|object; supports '--custom' props),
   //        dataset {}, on<Event> handlers (onClick, onInput...), ref(el), html (TRUSTED ONLY),
   //        value/checked/disabled/selected/indeterminate as properties, aria-*/role/etc as attributes;
   //        null/false/undefined props are skipped. children: string|number|Node|array|null|false (flattened).
export function mount(root, ...children)      // clear root then append
export function clear(el)
export function icon(name, {size=20, class: cls, title}={})  // → SVGElement (from icons.js)
export function toast(message, {type='info'|'success'|'error', duration=3200, action:{label,onClick}}={})
export function openSheet({ title, subtitle, content, actions, size='md'|'lg'|'full', onClose, accent })
   // Bottom sheet on mobile (<720px), centered dialog on desktop. Esc/backdrop closes, focus trapped,
   // returns focus to opener. content: Node or (api)=>Node.  actions: [{label, variant:'primary'|'secondary'|'ghost'|'danger',
   // icon, align:'start'|'end', onClick: async (api) => { ... } }] — action buttons go in sticky footer;
   // if onClick returns false the sheet stays open. accent: css var name e.g. '--food' (header icon/tint).
   // returns api = { el, body, close(result), setBusy(bool), result: Promise<any> }
export function confirmDialog({ title, message, confirmLabel='Delete', cancelLabel='Cancel', danger=true }) // → Promise<boolean>
export function field(label, control, { hint, error, required, inline=false }={})  // <label class="field"> wrapper; ties label↔control id
export function input(props)              // <input class="input">; props passed to h()
export function textarea(props)           // auto-grows with content
export function select(options, value, onChange, props?)   // options: [{value,label}] | string[]
export function segmented(options, value, onChange, { size='md', ariaLabel }={})  // options: [{value,label,icon}]; returns element with .setValue(v)
export function chips(options, selected, onChange, { multiple=false, allowAdd=false, onAdd, ariaLabel }={})
   // options: [{value,label,emoji,color}] | string[]; selected: value | value[]; onChange(newSelection)
export function tagInput(tags, onChange, { suggestions=[], placeholder='Add tag' }={})
export function ratingInput(value, onChange, { max=5, icon='star', labels }={})   // labels: ['Awful','Low','Okay','Good','Great'] etc
export function moodPicker(value, onChange)  // 5 faces 😫 😕 😐 🙂 😄 with labels; value 1..5|null
export function stepper(value, onChange, { min=0, max=Infinity, step=1, label })
export function toggle(checked, onChange, { label })     // switch
export function emptyState({ icon, title, message, action:{label, onClick, icon} })
export function pageHeader({ title, subtitle, actions=[], back })   // back: path for a back button
export function card({ title, subtitle, icon, accent, actions, children, class: cls, flush=false })
export function statTile({ label, value, sub, delta /*number, fraction*/, deltaGood:'up'|'down', tone /*'profit'|'loss'|null*/, accent, icon })
export function progressRing(fraction, { size=56, stroke=6, accent='--primary', label, sublabel })  // SVG
export function progressBar(fraction, { accent='--primary', over=false, height=8, label })
export function dateNav(date, onChange, { allowFuture=false })  // ‹  Mon, 24 Nov  › + 'Today' pill + native date picker
export function monthNav(month, onChange, { allowFuture=false })  // 'YYYY-MM'
export function menu(anchorEl, items)     // popover menu; items: [{label, icon, danger, onClick}]
export function debounce(fn, ms)
export function moneyInput(value, onInput, props)   // input with currency symbol prefix
```

### 3.6 `js/core/undo.js`
```js
export async function removeWithUndo(store, record, { label='Entry deleted', onUndo }={})
// deletes record, shows toast with "Undo" that re-puts the exact record.
```

### 3.7 `js/core/dates.js`
```js
todayKey(), toKey(date), fromKey(key) /*local midnight Date*/, addDays(key,n), diffDays(a,b) /*b-a*/,
startOfWeek(key, weekStart=settings), endOfWeek(key, weekStart), startOfMonth(key|month), endOfMonth(key|month),
monthOf(key) → 'YYYY-MM', addMonths(month, n), daysInMonth(month), rangeKeys(from,to) → keys[],
weekday(key) → 0..6, isoWeek(key) → '2026-W48', weekRange(isoWeekKey) → {from,to},
fmtDate(key, style) // 'short' "24 Nov" | 'medium' "Mon, 24 Nov" | 'long' "Monday, 24 November 2026" | 'weekday' "Mon" | 'monthYear' "Nov 2026"
fmtMonth(month) → "November 2026", relativeDay(key) → 'Today'|'Yesterday'|'Tomorrow'|fmtDate(key,'medium'),
nowTime() → 'HH:MM', fmtTime('HH:MM') → locale time "6:30 pm" (respects locale 12/24h),
isFuture(key), clampToToday(key), greeting() → 'Good morning'|'Good afternoon'|'Good evening'
```
All formatting uses `Intl` with the browser locale (`navigator.language`).

### 3.8 `js/core/format.js`
```js
fmtMoney(n, { sign=false, compact=false, decimals, currency }={})  // Intl currency; sign → '+₹1,200' / '−₹300' (true minus U+2212)
fmtNumber(n, { decimals, compact=false, sign=false }={})
fmtPrice(n)              // up to 8 significant decimals, trailing zeros trimmed
fmtPercent(fraction, { decimals=1, sign=false }={})
fmtDuration(minutes)     // '45m', '1h 20m', '3d 4h' for very long
fmtR(r)                  // '+1.8R' / '−0.5R'
pnlTone(n)               // 'profit' | 'loss' | 'neutral'
currencySymbol(code?)    // '₹', '$', '€'
CURRENCIES               // [{code:'INR', name:'Indian rupee'}, ...] ~30 common codes
fmtWeight(n) / fmtDistance(n)   // with unit from settings
```
Null/undefined/NaN inputs format as `'—'`.

### 3.9 `js/core/metrics.js`
```js
export const METRICS = {
  water:           { label:'Water', unit:'glasses', icon:'water', color:'--water', comparator:'gte' },
  calories:        { label:'Calories', unit:'kcal', icon:'flame', color:'--food', comparator:'lte', requiresData:true },
  protein:         { label:'Protein', unit:'g', icon:'food', color:'--food', comparator:'gte' },
  meals:           { label:'Meals logged', unit:'meals', icon:'food', color:'--food', comparator:'gte' },
  trainingMinutes: { label:'Training', unit:'min', icon:'training', color:'--training', comparator:'gte' },
  workouts:        { label:'Workouts', unit:'', icon:'training', color:'--training', comparator:'gte' },
  steps:           { label:'Steps', unit:'steps', icon:'footprints', color:'--training', comparator:'gte' },
  learnings:       { label:'Things learned', unit:'', icon:'learning', color:'--learning', comparator:'gte' },
  learningMinutes: { label:'Learning time', unit:'min', icon:'clock', color:'--learning', comparator:'gte' },
  spend:           { label:'Spending', unit:'money', icon:'expenses', color:'--expenses', comparator:'lte' },
  sleep:           { label:'Sleep', unit:'h', icon:'moon', color:'--mood', comparator:'gte' },
  reflection:      { label:'Daily reflection', unit:'bool', icon:'note', color:'--mood', comparator:'gte' },
  trades:          { label:'Trades journaled', unit:'', icon:'trades', color:'--trades', comparator:'gte' },
};
export async function loadRangeData(from, to)   // → {food, learning, workouts, expenses, trades, days:{[date]:day}}
export function metricsForDay(date, data)       // → DayMetrics (below) computed from loaded data
export async function getDayMetrics(date)
export async function getRangeMetrics(from, to) // → {[date]: DayMetrics}
export function evaluateGoal(goal, m)           // → {goal, value, target, done, progress /*0..1*/, over /*lte exceeded*/, applicable}
export async function getGoalsForDay(date)      // active goals applicable to that weekday, evaluated, ordered
export async function getDayScores(from, to)    // → {[date]: {score /*0..1 or null when no goals*/, done, total}}
export async function getLoggingStreak()        // → {current, best} consecutive days with hasAny (today counts if logged, else streak continues from yesterday)
export async function getGoalStreak(goalId)     // → {current, best}
export function defaultGoals(settings)          // → goal records used by onboarding
```
`DayMetrics = { date, calories, protein, carbs, fat, meals, water, trainingMinutes, workouts, steps,
distance, caloriesBurned, learnings, learningMinutes, spend, income, expenseCount, trades /*closed that day*/,
tradesOpened, tradePnl, tradeWins, tradeLosses, mood, energy, sleep, weight, reflection /*0|1*/, hasAny }`.
`trades` counts trades whose `date` is that day (any status); `tradePnl` sums `tradeNet` of closed trades
dated that day. `steps = day.steps ?? 0`. `reflection = 1` if any of intention/wins/reflection/gratitude is non-empty.
`lte` goals with `requiresData` are not `done` when the underlying data is empty (e.g. no meals logged).
`check` goals: `done = day.checks[goal.id] === true`.

### 3.10 `js/core/images.js`
```js
export async function compressImage(file, { maxSize=1600, quality=0.8 }={})  // → Blob (JPEG/WebP)
export async function saveImage(file)          // compress + store in 'files' → id
export async function imageURL(id)             // → object URL (cached)
export async function deleteImage(id)
export function thumb(id, { size=72, onClick })  // → <button><img></button> that loads lazily
export function openLightbox(ids, startIndex=0)  // full-screen viewer, swipe/arrow keys, Esc closes
export function imagePicker({ onAdd, label='Add photo', multiple=false })  // file input (accept image/*, capture on mobile)
```

### 3.11 `js/core/backup.js`
```js
export async function exportAll()               // → {app:'daybook', schema:1, exportedAt, stores:{name:[...]}} (files as dataURL)
export async function downloadBackup()          // saves 'daybook-backup-YYYY-MM-DD.json'; updates settings.lastBackupAt
export async function shareBackup()             // Web Share API with file when available, else download
export async function importBackup(fileOrObject, { mode='merge'|'replace' })  // validates; merge keeps newer updatedAt
export function toCSV(rows, columns)            // columns: [{key|value(row), label}] → string (RFC 4180 quoting)
export function downloadText(filename, text, mime)
export async function exportCSV(store, { from, to }={})   // sensible per-store columns
export async function clearAllData()            // clears every store (incl. settings) → emits db:change '*'
```

### 3.12 `js/core/charts.js` (SVG, responsive, theme-aware, with hover/tap tooltips)
```js
lineChart({ series:[{name, color /*css var name or color*/, points:[{x /*date key or label*/, y}]}],
            height=220, area=false, yFormat, xFormat, zeroLine=false, target /*number*/, showDots='auto', curve=true })
barChart({ data:[{label, value, color, tooltip}], height=220, yFormat, xFormat, signed=false /*green/red by sign*/,
           target, horizontal=false, maxBars, onClick(datum) })
stackedBarChart({ labels:[...], series:[{name,color,values:[...]}], height, yFormat })
donutChart({ data:[{label, value, color}], size=180, thickness=22, centerLabel, centerValue, valueFormat, legend=true, onClick })
heatmap({ values:{[dateKey]: number}, from, to, accent='--primary', weekStart, max, valueFormat, onClick(dateKey), signed=false })
   // GitHub-style weeks×weekdays grid; signed → green/red intensity for P&L
sparkline(values, { color='--primary', width=96, height=28, area=true })
histogram({ data:[{label, count, color}], height })
legend(items)   // [{label,color,value}]
```
All charts return an `HTMLElement` (wrapper div with an `<svg viewBox>` that fills its container width),
render gracefully with 0/1/many points, show an empty message when no data, and use `--chart-*` tokens.

### 3.13 `js/core/icons.js`
```js
export const ICONS        // { name: '<path d="..."/>...' } inner markup of a 24×24 stroke icon (Lucide style)
export const ICON_NAMES   // Object.keys(ICONS)
export function iconSVG(name, { size=20, strokeWidth=1.75, cls='', title }={})  // → '<svg class="icon ...">…</svg>' string
```
`ui.icon(name, opts)` turns that string into an element. **Only use these names** (all guaranteed to exist):
```
today home food water learning book brain training footprints activity heart-pulse bike expenses income
coins receipt wallet trades trending-up trending-down candlestick chart bar-chart line-chart pie insights
sparkles goals target calendar calendar-check search settings sliders more grid list menu plus minus x
check check-circle circle chevron-left chevron-right chevron-up chevron-down arrow-left arrow-right
arrow-up arrow-down arrow-up-right arrow-down-right edit trash copy star star-filled heart flame trophy
medal award clock timer camera image link external-link tag filter sort download upload share moon sun
monitor sunrise sunset info alert help smile meh frown zap bed repeat refresh rotate-ccw history eye
eye-off bookmark note pen file list-checks user lock shield cloud-off wifi-off archive database
smartphone install rocket leaf apple coffee salad pizza scale percent hash dollar crosshair flag
compass map-pin bell play pause layers keyboard notebook graduation-cap lightbulb mountain
```

---------------------------------------------------------------------------------------------------------

## 4. Modules

### 4.0 Module contract (`export default`)
```js
export default {
  id: 'food',                   // = route segment
  title: 'Food',
  icon: 'food',                 // icons.js name
  color: '--food',              // CSS custom property name
  render(root, ctx) {},         // may be async; may return a cleanup fn (or Promise of one)
  openEditor(record, opts) {},  // optional: opens add/edit sheet; record=null → new; opts={date}; → Promise<saved|null>
  quickActions: [],             // optional: [{id, label, icon, color, run({date})}] shown in the global "+" sheet
  summarizeDay(date) {},        // optional (daily modules + trades): → Promise<DaySummary>
  search(query) {},             // optional: → Promise<SearchResult[]>
};
// ctx = { route:{id, params, query, path}, navigate(path), setTitle(text) }
// DaySummary = { id, title, icon, color, headline /*e.g. '1,850 kcal · 96 g protein'*/, empty /*'No meals yet'*/,
//                items:[{ id, time, title, meta, onOpen() }], addLabel, onAdd() }
// SearchResult = { id, module, icon, color, title, subtitle, date, onOpen() }
```
Views re-render (or patch) on relevant `'db:change'` / `'settings:change'` events and unsubscribe in
cleanup. The registry (`js/modules/registry.js`) loads modules with `Promise.allSettled`, so a module
that fails to load shows an error card instead of breaking the app. `getModules()` / `getModule(id)`
give other modules access (e.g. Today calls every module's `summarizeDay`).

Editors (sheets) share one structure: header with module icon, form body, sticky footer with
`Delete` (existing records, danger, left), `Cancel`, `Save` (primary). Save validates (inline field
errors, no alerts), saves, toasts "Saved", resolves. Deletion uses `removeWithUndo`. Forms submit on
Enter from single-line inputs (wrap in `<form>` and handle `submit`). Default date = `opts.date ||
state.date || todayKey()`; default time = `nowTime()` when the date is today, else `''`.

### 4.1 Today (`today.js`, route `today`, params `[date]`)
The home screen and daily journal. Sets `state.date` (emit `'state:date'`).
- Header: greeting + name, `dateNav` (no future), relative-day label; tapping past dates shows a
  "Back to today" pill.
- **Day score** hero: progress ring of goals done/total, logging streak (🔥 n days), short motivational
  line based on progress.
- **Goals checklist**: `getGoalsForDay` — each goal row: icon chip, title, value/target with progress bar
  (lte goals show "used" and turn warning when over), manual check goals are tappable checkboxes
  (`db.patchDay(date,{checks:{[id]:bool}})`). Link to `#/goals` to manage.
- **Quick log** row: big icon buttons for every module quick action (Meal, +Water, Learned, Workout,
  Expense, Trade, …) using `getModules()`'s `quickActions`.
- **Water** mini-tracker: glasses (tap to set count), +/−.
- **Module cards** from each module's `summarizeDay(date)` (Food, Learning, Training, Expenses, Trading):
  headline, item list (tap → `onOpen`), add button.
- **Reflection card**: moodPicker, energy (1..5), sleep hours (stepper 0.5), intention, wins, reflection,
  gratitude textareas — autosave debounced 600 ms via `db.patchDay` with a subtle "Saved" indicator.
- **Resurface** card: a past learning from 7/30/90/365 days ago (or a due review) with a link to review.
- Backup reminder banner when `lastBackupAt` is older than `backupReminderDays` (or never and the user
  has ≥ 20 records): "Back up your journal" → Settings.
- Quick action exported by Today: none (Reflection is reached via the card).

### 4.2 Food (`food.js`, route `food`)
- `dateNav` day view. Top: calories ring vs `targets.calories`, protein ring vs `targets.protein`,
  carbs/fat small stats, **water tracker** (glasses, `targets.water`, `glassMl` → litres).
- Meals grouped Breakfast / Lunch / Dinner / Snacks with "+ Add" per group; each entry shows title,
  time, macros, quality badge, photo thumb.
- **Frequent foods**: chips of the 8 most-logged titles (with their last macros) → one tap re-logs to
  the current day with meal type guessed from time.
- Trends (last 7 / 30 days segmented): calories & protein line chart with target lines; meal-quality
  donut; average calories / protein / water.
- Editor: meal (segmented, default from time: <11 breakfast, <16 lunch, <21 dinner… snack otherwise),
  title (required, datalist of past titles autocompleting macros), calories/protein/carbs/fat, quality
  chips (Great 🥗 / Okay 🍝 / Poor 🍩), photo, note, date, time.
- Quick actions: `{id:'meal', label:'Meal'}`, `{id:'water', label:'+1 Water'}` (increments, toasts
  "💧 3/8 glasses" with Undo).
- `summarizeDay`, `search` (titles, notes).

### 4.3 Learning (`learning.js`, route `learning`)
- Tabs (segmented): **Feed** | **Review** | **Library**.
- Feed: stats strip (this week count, learning streak, minutes this month, total), entries grouped by
  date (newest first) as cards: category emoji, title, takeaway, source, tags, star; filter chips by
  category; text filter.
- Review: queue of entries with `nextReview <= today` (oldest first). Card shows title + category;
  "Reveal" shows takeaway/notes; buttons Again / Hard / Good (scheduling in 2.3); progress "3 of 7";
  celebratory empty state when done.
- Library: category breakdown donut, activity heatmap (last 26 weeks, count per day), top tags cloud,
  starred list.
- Editor: title (required), takeaway, notes, category chips, source chips + sourceName, link (url),
  minutes, tags, starred toggle, date.
- Quick action: `{id:'learning', label:'Learned'}`. `summarizeDay`, `search` (title, takeaway, notes, tags).

### 4.4 Training (`training.js`, route `training`)
- Week strip (weekStart-aware, 7 day pills marked when active, tap selects a day), weekly summary:
  minutes vs `weeklyTrainingMinutes` ring, workouts count, active days, calories burned.
- Selected day's workouts list + day's **steps** and **body weight** inline inputs (stored on `days`).
- Sections: **Personal records** (per exercise: best weight and best estimated 1RM = w × (1 + reps/30)),
  **Exercise progress** (select an exercise → line chart of top-set weight & est. 1RM over time),
  **Activity heatmap** (minutes/day, 26 weeks), **Body weight trend** line (last 90 days),
  minutes per week bar chart (last 12 weeks).
- Editor: type chips (from settings.workoutTypes), title, duration (stepper by 5 + input), intensity
  (1..10 slider with label), calories, distance (shown for cardio/walk/sports), exercises builder
  (shown for strength/hiit/other; add exercise with datalist of past exercise names, sets rows reps ×
  weight, add/duplicate/remove set, reorder not required), feeling, notes, date/time.
  "Repeat a past workout" button → pick from the last 10 → prefill (new date).
- Quick action: `{id:'workout', label:'Workout'}`. `summarizeDay`, `search`.

### 4.5 Expenses (`expenses.js`, route `expenses`)
- `monthNav`. Summary tiles: spent this month (vs `monthlyBudget` if set, with progress), income, net,
  daily average, and today's spend.
- Category breakdown: donut + ranked list with per-category budget bars (budget from category.budget).
- Daily spend bar chart for the month (target line = `targets.dailySpend` if set).
- Transactions grouped by day (newest first) with day totals; filter: All / Expenses / Income +
  category chips + search box. Row: category emoji chip, note or category name, method, amount
  (income in profit color with '+').
- Export month to CSV button.
- Editor: type segmented (Expense/Income), big amount input with currency symbol (required > 0),
  category grid chips (expense or income list), method chips, note, tags, date, time. "Save & add
  another" secondary action.
- Quick actions: `{id:'expense', label:'Expense'}`, `{id:'income', label:'Income'}`.
- `summarizeDay` (headline: "Spent ₹1,240" and income if any), `search` (note, category name, tags).

### 4.6 Trades (`trades/*`, route `trades`)
Sub-routes: `#/trades` (Journal), `#/trades/analytics`, `#/trades/calendar`, `#/trades/plan/[date]`,
`#/trades/view/<id>` (detail). `trades/index.js` renders the page header + tabs (Journal, Analytics,
Calendar, Daily plan) and delegates:
```js
// trades/analytics.js
export function renderAnalytics(root, ctx)      // → cleanup
// trades/calendar.js
export function renderTradeCalendar(root, ctx)  // → cleanup
// trades/dayplan.js
export function renderDayPlan(root, ctx)        // → cleanup   (ctx.route.params[1] = date)
// trades/editor.js
export function openTradeEditor(trade, { date, duplicateFrom }={})  // → Promise<saved|null>
// trades/detail.js
export function renderTradeDetail(root, ctx, tradeId)               // → cleanup
```
- **Journal** (index.js): filter bar (period presets: This week / This month / Last 30 days / YTD /
  All; account; market; status; setup; outcome; symbol search) persisted in sessionStorage; summary
  strip for the filtered set (net P&L, win rate, profit factor, trades); **Open positions** section;
  closed trades grouped by day with day P&L; row: symbol, direction badge, setup, time, R, net P&L
  (colored + signed). Tap → detail.
- **Editor** (editor.js): sections — Instrument (symbol with datalist, market chips, Long/Short big
  toggle, account), Entry (date, time, price, qty, multiplier under "Advanced"), Risk (stop, target →
  live risk amount + planned R:R), Exit (Open/Closed toggle; exit date/time/price, fees) with a **live
  P&L preview** (gross, fees, net, R, return %), Strategy (setup chips + add new → saved to settings,
  timeframe chips, confidence stars), Psychology (emotions multi-chips, mistakes multi-chips,
  followed plan yes/no, execution rating), Notes (thesis, review), Screenshots (imagePicker,
  thumbs, remove), P&L override under Advanced. Validation: symbol, entry price, qty required; closed
  requires exit price (unless override).
- **Detail** (detail.js): big header (symbol, direction, status, net P&L, R), key numbers grid, setup /
  emotions / mistakes chips, notes, screenshot gallery (lightbox), actions Edit / Duplicate / Delete,
  prev/next trade navigation.
- **Analytics** (analytics.js): filters (period, account, market, setup); KPI tiles (net P&L, win
  rate, profit factor, expectancy, avg R, trades, avg win, avg loss, max drawdown, best, worst,
  streaks); equity curve (area, zero line, starting balance), daily P&L bars (signed), P&L by setup /
  symbol (top 10) / weekday / entry hour / direction / market, R-multiple histogram, mistakes cost
  table (count, total P&L, avg), emotions vs win-rate table, followed-plan vs not comparison, and 3–5
  auto **insight callouts** in plain language (only when sample size ≥ 5).
- **Calendar** (calendar.js): monthNav; month grid with each day's net P&L and trade count, colored by
  sign/intensity; weekly totals column; month total; click a day → sheet with that day's trades and
  plan/review summary, link to Daily plan.
- **Daily plan** (dayplan.js): dateNav; Pre-market: bias segmented, mood before, watchlist / key levels,
  game plan, max loss today, rules checklist (settings.trading.rules); Post-market: that day's trades
  (mini list + day P&L), review, lessons, grade A–F segmented. Autosave to `days[date].trading`.
- Quick action: `{id:'trade', label:'Trade'}`. `summarizeDay` (day P&L, trades, open positions),
  `search` (symbol, setup, thesis, review, tags).

### 4.7 Goals (`goals.js`, route `goals`)
List of goals (active first, drag not required — up/down buttons for order), each with today's
status, 30-day hit-rate mini heatmap/sparkline and current/best streak. Editor: title, kind (Auto from
my logs / Manual checkbox), metric select (METRICS) + comparator + target (with unit), icon, color,
weekdays (all or chips), active toggle. "Suggested goals" chips to add quickly.

### 4.8 Calendar (`calendar.js`, route `calendar`)
Month grid (monthNav) with day-score color intensity; each day shows small colored dots for modules
with data (food, learning, training, expenses, trades). Mode segmented: Goals / Mood / Spending /
Trading P&L / Training. Tap day → `#/today/<date>`. Year heatmap below (current year, day score).

### 4.9 Insights (`insights.js`, route `insights`)
Period segmented: Week / Month / Year, with prev/next navigation. Sections: KPI tiles per area with
delta vs previous period (avg calories, protein, water, training minutes, workouts, learnings, spend,
income, trading P&L, win rate, avg mood, avg sleep, day score); trend charts (day score, mood & energy,
training minutes, spending, trading equity); **Connections** — computed comparisons with plain-language
text, shown only with ≥ 5 days per group: mood on training vs rest days; trading P&L on days with
sleep ≥ 7h vs < 7h; spending on high- vs low-mood days; trading P&L on training days vs rest days;
highlights (best day, top learning category, biggest expense, best trade). **Period review** form
(rating, what went well, what to improve, focus next) stored in `reviews`.

### 4.10 Search (`search.js`, route `search`, `?q=`)
Debounced input (autofocus), calls every module's `search(q)` (min 2 chars), groups results by module
with counts, highlights the matched text (safely, via text nodes + `<mark>`), recent searches in
localStorage (try/catch). Also searches `days` (intention/wins/reflection/gratitude, trading review).

### 4.11 Settings (`settings-view.js`, route `settings`)
Sections: Profile (name), Appearance (theme segmented System/Light/Dark, week start), Regional
(currency select from CURRENCIES, weight & distance units), Daily targets (all `targets`), Expense
categories (add / rename / emoji / color / monthly budget / delete), Income categories, Payment
methods, Learning categories, Workout types, Trading (currency override, accounts with starting
balance, setups, mistakes, emotions, rules), **Data & backup** (last backup date, Download backup,
Share backup (mobile), Restore from file with Merge/Replace choice, CSV exports per module, storage
usage via `navigator.storage.estimate`, "Keep data persistent" via `navigator.storage.persist()`,
Load sample data / Remove sample data, Delete everything — requires typing DELETE), Install app
(uses deferred `beforeinstallprompt` from `window.daybook.installPrompt`; iOS instructions), About
(version, privacy statement: "Your data never leaves this device").

### 4.12 Onboarding (`onboarding.js`, route `welcome`)
4 steps with progress dots, full-screen, no shell nav: (1) Welcome + what Daybook does + name;
(2) currency (pre-selected from `navigator.language` region, e.g. en-IN→INR, en-US→USD, en-GB→GBP,
de-DE→EUR) + units + week start; (3) choose daily goals from presets with editable targets (water,
protein, calories, training minutes, learn 1 thing, spending ≤ X, sleep, reflection, steps) — sensible
defaults pre-selected; (4) "Start fresh" or "Explore with sample data". Finishing saves settings
(`onboarded: true`), creates goals, requests persistent storage, navigates to Today.

### 4.13 Sample data (`sample-data.js`)
```js
export async function loadSampleData({ days=75 }={})   // deterministic (seeded PRNG), realistic, all stores, sample:true
export async function removeSampleData()               // deletes every record with sample:true (+ their files)
export async function hasSampleData()
```
Realistic: 3–4 meals/day with macros (mix of Indian and international foods), water 4–10, 0–2
learnings/day (real-sounding takeaways), 4–5 workouts/week (strength with exercises progressing over
time, runs, yoga), body weight drifting, steps, 2–6 expenses/day + monthly salary/rent, ~0–4 trades per
weekday across setups with ~52% win rate, some mistakes/emotions, a few open trades, mood/energy/sleep/
reflections on most days, trading day plans on some days, 2 weekly reviews. Also creates default goals
if none exist. Must not overwrite non-sample user records.

---------------------------------------------------------------------------------------------------------

## 5. App shell (`index.html`, `js/app.js`, `css/base.css`)

- Boot: `openDB()` → `loadSettings()` → apply theme (`<html data-theme>` = light/dark or removed for
  system; update `<meta name=theme-color>`) → `loadModules()` → build shell → `startRouter()` →
  register service worker → expose `window.daybook = { db, getSettings, updateSettings, navigate, bus:{on,emit}, state, getModules, version, installPrompt }`
  → set `window.__daybookReady = true` and dispatch `'daybook:ready'` on window.
  If `!settings.onboarded` and route ≠ `welcome` → `navigate('/welcome', {replace:true})`.
- Global error handler shows a friendly inline error card with "Reload" (never a blank screen).
- **Desktop (≥ 960px)**: fixed left sidebar (brand mark + "Daybook"; "+ New" button; nav groups:
  Today · Journal: Food, Learning, Training, Expenses · Trading: Trades · Review: Goals, Calendar,
  Insights · Search, Settings; install button when available). Content column max-width 1120px.
- **Mobile (< 960px)**: top bar (page title, search icon), bottom tab bar: Today · Journal · Trades ·
  Insights · More (More opens a sheet: Goals, Calendar, Search, Settings, Install). "Journal" goes to the
  last-used of food/learning/training/expenses (default food) and is active on any of them; those four
  pages show a sticky segmented switcher (Food · Learn · Train · Money) under the top bar.
- **FAB** "+" (bottom-right, above bottom nav on mobile) opens the Quick add sheet: grid of all module
  `quickActions` (colored icon tiles). Keyboard: `n` opens quick add, `/` goes to search, `g t` today
  (ignore when typing in inputs).
- Safe areas: use `env(safe-area-inset-*)` for top bar, bottom nav, FAB.
- Route change: run previous cleanup, clear view, render module (await), update active nav, title
  (`<Page> · Daybook`), scroll to top, move focus to the view's first `h1` (tabindex -1).
  **After every render completes** (success or error card) set
  `document.documentElement.dataset.route = route.path` (e.g. `'/food'`, `'/trades/plan/2026-11-24'`,
  no query string) and dispatch `'daybook:rendered'` on window — `tools/smoke.py` waits on this.
  The view container is `<main id="view">`. Every page renders exactly one `<h1>`.
- Service worker update: when a new worker is waiting, toast "Update ready" with "Reload" action →
  `postMessage({type:'SKIP_WAITING'})` then reload on `controllerchange`.
- Theme follows `settings:change`.

---------------------------------------------------------------------------------------------------------

## 6. Design system

**Direction:** calm, premium, focused — "Things × Apple Health × a pro trading journal". Light by
default with a true dark theme. Soft neutral background, white cards with 1px border + very soft shadow,
generous spacing, big confident numbers (tabular figures), module colors used as accents only (icon
chips, rings, chart series) — never large saturated fills. Motion 150–250 ms ease-out, respect
`prefers-reduced-motion`.

**Tokens (`css/tokens.css`)** — defined on `:root` (light), overridden for dark under
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` and
`:root[data-theme="dark"] {...}` (set `color-scheme` accordingly):
- Surfaces/text: `--bg`, `--surface`, `--surface-2` (subtle fill), `--surface-3`, `--border`,
  `--border-strong`, `--text`, `--text-2` (secondary), `--text-3` (muted), `--overlay`.
- Brand: `--primary` (indigo ~#4f46e5 light / #818cf8 dark), `--primary-contrast`, `--focus`.
- Status: `--success`, `--warning`, `--danger`, `--profit`, `--loss`, `--neutral`.
- Module accents: `--food` (orange), `--water` (cyan), `--learning` (violet), `--training` (emerald),
  `--expenses` (sky/teal), `--trades` (indigo/blue), `--mood` (pink), `--goals` (amber).
  Soft tints are derived in components with `color-mix(in srgb, var(--accent) 14%, transparent)`.
- Charts: `--chart-grid`, `--chart-axis`, `--chart-1..8` (categorical, distinguishable, CVD-safe-ish).
- Radii `--r-sm 8px`, `--r 12px`, `--r-lg 16px`, `--r-xl 24px`, `--r-full 999px`.
- Shadows `--shadow-sm`, `--shadow`, `--shadow-lg`.
- Type: `--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  `--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`; sizes `--fs-xs 12px`,
  `--fs-sm 13px`, `--fs-md 15px`, `--fs-lg 17px`, `--fs-xl 20px`, `--fs-2xl 24px`, `--fs-3xl 32px`.
- Spacing scale `--s-1 4px … --s-8 48px` (1:4, 2:8, 3:12, 4:16, 5:20, 6:24, 7:32, 8:48).
- Layout: `--sidebar-w 248px`, `--topbar-h 56px`, `--bottomnav-h 64px`, `--content-max 1120px`.

**Shared classes (`css/components.css`)** — modules must reuse these rather than re-inventing:
- Layout: `.page`, `.page-header`, `.page-title`, `.page-subtitle`, `.page-actions`, `.section`,
  `.section-title` (+ `.section-link`), `.stack` (+ `.stack-sm/.stack-lg`), `.row` (flex, gap, wrap,
  center), `.row-between`, `.grid` + `.grid-2/.grid-3/.grid-4/.grid-auto` (collapse on mobile), `.spacer`.
- Card: `.card`, `.card-header`, `.card-title`, `.card-subtitle`, `.card-actions`, `.card-body`,
  `.card-footer`, `.card-flush`, `.card-accent` (uses `--accent` for a top hairline/tint),
  `.card-interactive` (hover lift).
- Buttons: `.btn` + `.btn-primary/.btn-secondary/.btn-ghost/.btn-danger/.btn-success`, `.btn-sm/.btn-lg`,
  `.btn-icon`, `.btn-block`, `.btn-pill`; `.link-btn`.
- Forms: `.field`, `.field-label`, `.field-hint`, `.field-error`, `.field-row` (inline pair),
  `.form-grid` (2 cols ≥ 640px), `.input`, `.textarea`, `.select`, `.input-affix` (prefix/suffix),
  `.input-lg` (big amount), `.switch`, `.checkbox`, `.range`.
- Controls: `.segmented` (+ `.segmented-btn`, `[aria-checked=true]`), `.chips`, `.chip` (+ `.is-selected`,
  `--accent`), `.tag`, `.badge` + `.badge-profit/.badge-loss/.badge-neutral/.badge-long/.badge-short/
  .badge-open/.badge-accent`, `.stepper`, `.rating`, `.mood-picker`.
- Data: `.stat`, `.stat-label`, `.stat-value`, `.stat-sub`, `.stat-delta (.up/.down/.good/.bad)`,
  `.stat-grid`, `.list`, `.list-item`, `.list-item-icon`, `.list-item-main`, `.list-item-title`,
  `.list-item-meta`, `.list-item-trail`, `.list-group-header`, `.table-wrap` + `.table` (overflow-x auto,
  sticky header, numeric columns `.num` right-aligned), `.kv` (key/value grid), `.empty-state`,
  `.progress` (+ `.progress-fill`, `.is-over`), `.ring`, `.icon-chip` (rounded square tinted with
  `--accent`, colored icon; sizes `.icon-chip-sm/.icon-chip-lg`), `.emoji-chip`, `.divider`.
- Text utils: `.muted`, `.subtle`, `.num` (tabular-nums), `.text-profit`, `.text-loss`, `.text-sm`,
  `.text-xs`, `.text-lg`, `.truncate`, `.clamp-2`, `.sr-only`, `.hide-mobile`, `.hide-desktop`.
- Overlays: `.sheet-backdrop`, `.sheet`, `.sheet-header`, `.sheet-body`, `.sheet-footer`, `.toast-stack`,
  `.toast`, `.menu`, `.lightbox`, `.chart-tooltip`.
- Accents: any element may set `style="--accent: var(--food)"`; components use `var(--accent, var(--primary))`.

Module CSS lives in `css/modules/<name>.css`, scoped under a root class (`.food-page`, `.trades-page`…).
