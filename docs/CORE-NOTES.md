# Daybook core — cheat-sheet for module authors

Read `docs/SPEC.md` first (section 0 rules are binding). This file lists what the core **actually** exports,
how it behaves where the spec is vague, and the traps. Everything here was verified against the code and in
the browser (`tools/tests/core.html`, `tools/styleguide.html`, `tools/charts-demo.html`, a module built from
the skeleton at the end of this file).

Imports are relative with `.js`: from `js/modules/x.js` use `'../core/ui.js'`; from `js/modules/trades/x.js`
use `'../../core/ui.js'`. Live references: **`tools/styleguide.html`** (every UI component, light/dark, phone/desktop)
and **`tools/charts-demo.html`** (every chart + the full icon grid).

---------------------------------------------------------------------------------------------------------

## 1. Exports by file

### `js/core/ui.js` — DOM + components (styles in `css/components.css`)
| export | one-line usage |
|---|---|
| `h(tag, props?, ...children)` | `h('div.card.big', { onClick, style: { '--accent': 'var(--food)' }, dataset: { id } }, 'text', node, [list])` — `'svg:path'` for SVG; `text:` sets textContent; `html:` **trusted SVG only**; `ref(el)`; `on:{evt:fn}` |
| `mount(root, ...kids)` / `clear(el)` | replace / empty children |
| `icon(name, {size=20, class, title, strokeWidth})` | `icon('trash', { size: 18 })` → `<svg class="icon icon-trash">` |
| `button({label, icon, iconEnd, variant='secondary', size, iconOnly, pill, block, ariaLabel, onClick, ...props})` | variants: primary secondary ghost danger danger-solid success plain |
| `iconChip(name, {accent, size:'sm'\|'md'\|'lg', emoji, solid})` | `iconChip('food', { accent: '--food' })` |
| `badge(label, variant, {icon, accent, dot, size})` | `badge('Long', 'long')` — profit loss neutral long short open accent warning |
| `spinner({size})`, `skeleton({width, height, lines, circle})` | loading placeholders |
| `toast(msg, {type, duration, action:{label,onClick}, onClose})` | `toast('Saved', { type: 'success' })` → `{el, close}` |
| `openSheet({...})` | see §3 — bottom sheet < 720px, dialog ≥ 720px |
| `confirmDialog({title, message, confirmLabel='Delete', cancelLabel, danger=true, icon})` | `if (await confirmDialog({ title: 'Delete trade?' })) …` → `Promise<boolean>` |
| `promptDialog({title, message, label, value, placeholder, confirmLabel, validate, inputProps})` | → `Promise<string\|null>` |
| `field(label, control, {hint, error, required, inline, aside, id})` | **returns `<div class="field">`** with `.setError(msg\|null)`, `.setHint()`, `.control`, `.input` |
| `input(props)` | `input({ type: 'number', value })` — number gets `step="any" inputmode="decimal"` |
| `textarea(props)` | auto-grows; call `el.autogrow()` after setting `.value` programmatically |
| `select(options, value, onChange(value, e), props)` | `select(['kg','lb'], 'kg', v => …)` — `.setValue/.getValue` |
| `segmented(options, value, onChange, {size, ariaLabel, block})` | `[{value, label, icon}]` — `.setValue/.getValue` |
| `chips(options, selected, onChange, {multiple, allowAdd, onAdd, ariaLabel, size, scroll, deselect=true, addLabel})` | `.setValue/.getValue/.setOptions` |
| `tagInput(tags, onChange(tags[]), {suggestions, placeholder, max})` | lowercase tags — `.setTags/.getTags` |
| `ratingInput(value, onChange, {max=5, icon='star', labels, ariaLabel, size})` | tap again clears → `null` |
| `moodPicker(value, onChange, {labels, emojis, ariaLabel})` | 1..5 \| null, tap again clears |
| `stepper(value, onChange, {min=0, max, step=1, label, unit, decimals})` | `stepper(8, n => …, { unit: 'glasses' })` |
| `toggle(checked, onChange, {label, ariaLabel, end, hint, disabled})` | `<label class="switch">` |
| `checkbox(checked, onChange, {label, strike, ariaLabel, accent})` | `<label class="checkbox">` |
| `range(value, onChange, {min, max, step, label, accent})` | slider with filled track |
| `moneyInput(value, onInput(number\|null), {currency, size:'lg', ...inputProps})` | currency-symbol prefix; `.input`, `.getValue()` |
| `emptyState({icon, title, message, action:{label,onClick,icon}, actions, accent, compact})` | always offer the next action |
| `pageHeader({title, subtitle, actions, back, children})` | renders the page's **one `<h1>`** (`back`: path or fn) |
| `section({title, action:{label, onClick\|href}, children})` | `<section class="section">` + `.section-title` |
| `card({title, subtitle, icon, emoji, accent, actions, children, class, flush, onClick, titleTag='h2'})` | `el.body` = content container |
| `statTile({label, value, sub, delta, deltaGood='up', tone, accent, icon, unit, onClick})` | `delta` is a fraction; `tone: pnlTone(n)` |
| `progressRing(fraction, {size=56, stroke=6, accent, label, sublabel, over})` | `el.update(f, {label, sublabel, over})` |
| `progressBar(fraction, {accent, over, height=8, label})` | `el.update(f, {over})` |
| `listItem({icon, emoji, accent, lead, title, meta, trail, trailMeta, onClick, href, chevron})` | `meta` may be an array (joined with ·) |
| `listGroupHeader(label, trail, {sticky})` | e.g. day header with day total |
| `kv(pairs, {grid})` | `kv([['Entry', '22,140'], { label: 'Net', value: '+₹900', tone: 'profit' }])` |
| `table({columns:[{key\|value(row), label, num, format, render, wrap}], rows, compact, empty, footer, onRowClick, maxHeight, caption})` | sticky header, `.num` right-aligned |
| `dateNav(date, onChange, {allowFuture=false, min})` | `.setDate/.getDate` |
| `monthNav(month, onChange, {allowFuture=false})` | `.setMonth/.getMonth` |
| `menu(anchorEl, items, {align, ariaLabel})` | items `{label, icon, danger, onClick, hint, checked, disabled}` \| `{divider:true}` \| `{heading}` |
| `popover(anchorEl, content, {align, ariaLabel, onClose})` | calling again on the same anchor closes it |
| `debounce(fn, ms)` | has `.cancel()`, `.flush()`, `.pending()` |
| `colorVar(c)` | `'--food'` → `'var(--food)'`; hex/`var()` pass through |
| `uniqueId(prefix)`, `pushEscape`, `lockScroll`, `unlockScroll`, `isolate` | low-level overlay helpers |

### `js/core/undo.js`
`removeWithUndo(store, record, {label='Entry deleted', onUndo, files=[], duration=6000})` →
`{record, undo(), undone: Promise<boolean>}`. Deletes now, toast with Undo re-puts the exact record (timestamps kept).
`files`: image ids owned by the record — deleted only after the undo window closes without Undo:
`removeWithUndo('trades', t, { label: 'Trade deleted', files: t.screenshots })`.

### `js/core/images.js`
| export | usage |
|---|---|
| `imagePicker({onAdd(id, file), label='Add photo', multiple, capture, variant, size, icon})` | saves each image to `files` **immediately**; `onAdd` called once per image |
| `thumb(id, {size=72, onClick, ids, index, alt, onRemove})` | lazy `<button class="thumb">`; with `onRemove` returns a wrapper with × |
| `openLightbox(ids, startIndex=0)` | swipe / arrows / Esc |
| `saveImage(file)` → id · `imageURL(id)` → objectURL\|null · `deleteImage(id)` · `compressImage(file, {maxSize, quality})` → Blob | |

### `js/core/db.js`
`db.get(store, key)` · `db.put(store, record, {touch=true})` → **new saved object** · `db.bulkPut(store, records)` ·
`db.delete(store, key)` → previous record · `db.bulkDelete(store, keys)` · `db.all(store)` · `db.byDate(store, date)` ·
`db.byRange(store, from, to)` (**inclusive**; either end may be null) · `db.byIndex(store, index, value|IDBKeyRange)` ·
`db.count(store)` · `db.clear(store)` · `db.getDay(date)` (full defaults) · `db.getDays(from, to)` → `{[date]: day}` (stored days only) ·
`db.patchDay(date, patch)` → saved day · `db.getMeta(key, fallback)` / `db.setMeta(key, value)`.
Also: `uid()`, `openDB()`, `STORES`, `keyPathOf(store)`, `emptyDay(date)`, `deepMerge(a, b)`, `clone(v)`, `sortRecords(list)`, `runTransaction` (low level).
Lists come back sorted by `date`, then `time` (trades: exit/entry time), then `createdAt`, **ascending** — `.reverse()` for newest first.

### `js/core/bus.js`
`on(event, fn)` → `off()` · `once(event, fn)` · `emit(event, payload)` · `state` (`state.date` = working date) ·
`setWorkingDate(date)` (sets `state.date` + emits `'state:date'` only if changed — Today uses it).
Events: `'db:change'` `{store, op, key, record}` (bulk ops: `key/record` null + `records|keys`, `count`, `bulk:true`;
`patchDay` adds `patch`), `'settings:change'` `{settings, patch}`, `'route:change'` `{route}`, `'state:date'` `{date}`.

### `js/core/settings.js`
`DEFAULT_SETTINGS` · `loadSettings()` (boot only) · `getSettings()` · `updateSettings(patch)` → new settings ·
`isSettingsLoaded()` · lookups `expenseCategory(id)`, `incomeCategory(id)`, `moneyCategory(type, id)`,
`learningCategory(id)`, `workoutType(id)`, `tradingAccount(id)`.

### `js/core/dates.js`
Keys: `todayKey()`, `toKey(date|ts|iso)`, `fromKey(key)`, `isValidKey(k)`, `addDays(k, n)`, `diffDays(a, b)` (= b − a),
`weekday(k)` (0 = Sun), `startOfWeek(k, ws?)`, `endOfWeek(k, ws?)`, `weekKeys(k, ws?)`, `monthOf(k)`, `currentMonth()`,
`addMonths(m, n)`, `daysInMonth(m)`, `startOfMonth(k|m)`, `endOfMonth(k|m)`, `monthRange(m)` → `{from,to}`, `monthKeys(m)`,
`rangeKeys(from, to)`, `daysAgo(n)`, `isoWeek(k)` → `'2026-W48'`, `weekRange('2026-W48')` → `{from,to}`, `isToday(k)`,
`isFuture(k)`, `clampToToday(k)`.
Display: `fmtDate(k, style)` — `short` "24 Nov" · `shortYear` · `medium` "Mon, 24 Nov" · `mediumYear` · `long` ·
`weekday` "Mon" · `weekdayLong` · `narrow` "M" · `monthYear` "Nov 2026" · `month` "Nov" · `day` "24";
`fmtMonth(m)` "November 2026", `fmtRange(from, to)`, `weekdayLabels(ws, 'short'|'narrow'|'long')`, `relativeDay(k)`,
`nowTime()` 'HH:MM', `fmtTime('18:30')` → "6:30 pm" ('' when empty), `timeToMinutes`, `minutesToTime`, `greeting()`, `locale()`.
Invalid input never throws: keys → `null`, display → `'—'`, `fmtTime` → `''`.

### `js/core/format.js`
`fmtMoney(n, {sign, compact, decimals, currency})` · `fmtTradeMoney(n, opts)` (trading currency) · `fmtNumber(n, {decimals, maxDecimals, compact, sign})` ·
`fmtPrice(n)` · `fmtPercent(fraction, {decimals=1, sign})` · `fmtDuration(min)` "1h 20m" · `fmtR(r, {decimals=1})` "+1.8R" ·
`pnlTone(n)` → `'profit'|'loss'|'neutral'` · `currencySymbol(code?)` · `CURRENCIES` · `fmtWeight(n)` / `fmtDistance(n)` ·
`plural(3, 'meal')` "3 meals" · `toNumber(v)` (→ number|null) · `tradeCurrency()` · `guessCurrency(locale)`.

### `js/core/metrics.js`
`METRICS` · `loadRangeData(from, to)` · `metricsForDay(date, data)` · `getDayMetrics(date)` · `getRangeMetrics(from, to)` →
`{[date]: DayMetrics}` · `evaluateGoal(goal, m)` → `{goal, value, target, done, progress, over, applicable, comparator, noData}` ·
`getGoalsForDay(date)` · `getDayScores(from, to)` → `{[date]: {score|null, done, total}}` · `getLoggingStreak()` / `getGoalStreak(id)` → `{current, best}` ·
`getGoalHistory(goalOrId, from, to)` · `defaultGoals(settings)` · `goalApplies(goal, date)` · `sortGoals(goals)` ·
`formatMetricValue('water', 6)` → "6 glasses".

### `js/core/backup.js`
`exportAll()` · `downloadBackup()` · `shareBackup()` · `importBackup(fileOrObject, {mode:'merge'|'replace'})` → counts ·
`toCSV(rows, columns)` · `downloadText(name, text, mime)` · `exportCSV(store, {from, to, download=true})` → `{filename, csv, count}` ·
`clearAllData()` · `backupCounts(backup)` · `dataURLToBlob(url)` · `BACKUP_SCHEMA`.
After import/clear it emits `db:change {store:'*'}` and `settings:change`.

### `js/core/charts.js` (no imports; every chart → `<div class="chart">`, `el.update(patch)` re-renders)
| export | key options |
|---|---|
| `lineChart({series:[{name, color, points:[{x, y}]}], ...})` | `height=220, area, yFormat, xFormat, zeroLine, target, targetLabel, showDots, curve, legend, tooltipFormat, tooltipTitle, emptyText, ariaLabel` |
| `barChart({data:[{label, value, color, tooltip}], ...})` | `signed` (green/red by sign), `horizontal`, `maxBars` (keeps first n), `target`, `onClick(datum)`, `valueLabels`, `yFormat`, `tooltipFormat` |
| `stackedBarChart({labels, series:[{name, color, values}], height, yFormat, xFormat, legend})` | |
| `donutChart({data:[{label, value, color}], size=180, thickness=22, centerLabel, centerValue, valueFormat, legend, onClick})` | 9th+ slice folds into "Other" |
| `heatmap({values:{[date]: n}, from, to, accent, weekStart, max, valueFormat, onClick(date), signed, emptyLabel, legend})` | GitHub-style grid |
| `histogram({data:[{label, count, color}], height, yFormat, color, onClick})` | e.g. with `rDistribution()` |
| `sparkline(values, {color, width=96, height=28, area})` | tiny trend for stat tiles |
| `legend(items, {shape})` · `seriesColor(i)` · `niceTicks(lo, hi, n)` | |
Colors: `'--food'`, `'var(--x)'`, `'#hex'`; omitted → `--chart-1..8` in order.

### `js/core/icons.js`
`ICONS`, `ICON_NAMES`, `hasIcon(name)`, `iconSVG(name, {size, strokeWidth, cls, title})` (string). Use `ui.icon()` in modules.

### `js/core/router.js`
`navigate(path, {replace, silent})` (`'/food'`, `'#/food'`, `'/search?q=dal'`) · `currentRoute()` → `{id, params, query, path}` ·
`parseHash(hash)` · `startRouter(fn)` (app.js only). Navigating to the current hash re-renders it. `silent:true` only rewrites the URL.

### `js/modules/registry.js` (do not edit)
`getModules()` (registry order) · `getModule(id)` · `getModuleError(id)` · `moduleIds()` · `loadModules()` (app.js only).

### `js/modules/trades/calc.js` (do not edit — the only place for P&L math)
`prepareTrade(t)` (**call before every save**; returns a new object with the index `date`) · `tradeGross` · `tradeNet` ·
`tradeRisk` · `tradeR` · `plannedRR` · `potentialReward` · `notional` · `tradeReturnPct` (fraction) · `holdMinutes` ·
`outcome(t)` → `'win'|'loss'|'breakeven'|'open'|'unknown'` · `isOpen` / `isClosed` · `dirSign` · `tradeSortKey` ·
`sortTrades(list, 'asc'|'desc')` · `closedWithPnl(list)` · `computeStats(list)` → `{count, open, wins, losses, breakeven, winRate,
net, grossProfit, grossLoss, fees, profitFactor, avgWin, avgLoss, payoffRatio, expectancy, avgR, totalR, best, worst,
largestWin, largestLoss, maxWinStreak, maxLossStreak, currentStreak, maxDrawdown, avgHoldMinutes, …}` ·
`equitySeries(list, {start})` · `dailyPnl(list)` → `{[date]: {pnl, count, wins, losses}}` ·
`groupStats(list, keyFn, {emptyLabel, sort})` · `rDistribution(list, edges)` · `MARKET_LABELS` · `TIMEFRAMES` · `num` · `round8`.
Open trades return `null` for every P&L value.

---------------------------------------------------------------------------------------------------------

## 2. CSS you should reuse (`css/components.css`, `css/base.css`)

- **Layout**: `.page` (column, 24px gaps, max 1120px) · `.page-header` · `.section` + `.section-title` + `.section-link` ·
  `.stack` / `.stack-sm` / `.stack-lg` · `.row` · `.row-between` · `.spacer` · `.grid` + `.grid-2/.grid-3/.grid-4/.grid-auto`
  (`--grid-min`) · `.col-span-2` · `.form-grid` (2 cols ≥ 640px) · `.field-row`.
- **Surfaces**: `.card` (+ `.card-flush`, `.card-accent`, `.card-interactive`) · `.callout` · `.list` / `.list-boxed` /
  `.list-item…` · `.table-wrap` + `.table` · `.kv` / `.kv-grid` · `.stat` / `.stat-grid` / `.stat-plain` · `.empty-state`.
- **Controls**: `.btn` (+ `-primary/-secondary/-ghost/-danger/-danger-solid/-success`, `-sm/-lg`, `-icon`, `-block`, `-pill`) ·
  `.link-btn` · `.input` `.select` `.textarea` `.input-affix` `.input-lg` · `.chip` / `.chips` / `.chips-scroll` · `.segmented` ·
  `.badge-*` · `.tag` · `.icon-chip` (`-sm/-lg/-solid`) · `.emoji-chip` · `.progress` · `.ring` · `.divider` · `.skeleton`.
- **Text**: `.muted` (text-3) · `.subtle` (text-2) · `.num` (tabular, no wrap) · `.text-profit` · `.text-loss` · `.text-warning` ·
  `.text-xs/.text-sm/.text-lg` · `.text-strong` · `.truncate` · `.clamp-2` · `.sr-only` · `.hide-mobile` / `.hide-desktop`.
- **Accent**: set `style: { '--accent': 'var(--food)' }` on any ancestor; components read `var(--accent, var(--primary))`.
- **Breakpoints**: 640 (form/grid columns) · **720** (sheet → centred dialog; card padding) · **960** (bottom nav → sidebar;
  `.hide-mobile`/`.hide-desktop`). Use the same numbers in module CSS (`max-width: 959.98px` for "phone/tablet").
- **Tokens**: spacing `--s-1..8`, radii `--r-sm/--r/--r-lg/--r-xl/--r-full`, type `--fs-xs..--fs-4xl`, motion `--ease`,
  `--dur-fast/--dur/--dur-slow`, layers `--z-sticky/--z-nav/--z-sheet/--z-menu/--z-toast`, soft tints `--primary-soft`,
  `--profit-soft`, `--loss-soft`, `--success-soft`, `--warning-soft`, `--danger-soft`. Never hard-code colours.
- Module CSS goes in `css/modules/<name>.css`, scoped under one root class (`.food-page …`). Don't restyle shared classes globally.

## 3. Icon names
Guaranteed (SPEC 3.13): today home food water learning book brain training footprints activity heart-pulse bike expenses
income coins receipt wallet trades trending-up trending-down candlestick chart bar-chart line-chart pie insights sparkles
goals target calendar calendar-check search settings sliders more grid list menu plus minus x check check-circle circle
chevron-left chevron-right chevron-up chevron-down arrow-left arrow-right arrow-up arrow-down arrow-up-right
arrow-down-right edit trash copy star star-filled heart flame trophy medal award clock timer camera image link
external-link tag filter sort download upload share moon sun monitor sunrise sunset info alert help smile meh frown zap
bed repeat refresh rotate-ccw history eye eye-off bookmark note pen file list-checks user lock shield cloud-off wifi-off
archive database smartphone install rocket leaf apple coffee salad pizza scale percent hash dollar crosshair flag compass
map-pin bell play pause layers keyboard notebook graduation-cap lightbulb mountain.
Extras that exist today (see the grid in charts-demo): arrow-down-left arrow-up-left bag ban banknote bar-chart-horizontal
beef brain-circuit bus calendar-days calendar-plus calendar-range car carrot cart chart-area check-square circle-alert
circle-dot circle-plus circle-x cloud command cookie droplets egg film gauge gift glass-water globe grip hammer hard-drive
headphones landmark library list-filter log-out mail maximize minimize more-horizontal more-vertical music newspaper party
party-popper piggy-bank pill plane podcast printer quote redo ruler save scan shuffle sidebar soup sparkle square
square-pen sticky-note swords thumbs-down thumbs-up undo users video wallet-cards wand waves weight wine.
Unknown names render a dotted circle (ui.icon) and warn once — they never throw.

---------------------------------------------------------------------------------------------------------

## 4. Gotchas (read these)

**UI kit**
- `field()` returns **`<div class="field">`** (not a `<label>`): the `<label for>` is inside, so taps on chips/segmented
  never click the wrong button. Use `f.setError('…')` / `f.setError(null)` for inline errors; it sets `aria-invalid`.
  Group controls (chips, segmented, rating, mood) are tied via `aria-labelledby` automatically.
- `openSheet({ title, subtitle, icon, accent, content, actions, size, onClose, guard, initialFocus, dismissible })` → api
  `{ el, body, footer, close(value), setBusy, result, setTitle, setSubtitle, setActions, submit, dismiss }`.
  - `await api.result` → whatever closed it: an action's return value, `close(v)`, or `null` (Esc/backdrop/×/Cancel).
  - `actions: [{label, variant, icon, align, onClick(api)}]` — `onClick` may be async; the sheet shows busy state while it
    runs; **returning `false` keeps it open** (validation); a thrown error toasts and keeps it open. An action **without
    `onClick` closes with its `value`** (default `null`). Danger actions go to the left automatically.
  - `guard: async (api) => boolean` runs on Esc/backdrop/swipe/× — return `false` to keep the sheet (e.g. "Discard changes?"
    with `confirmDialog`).
  - **Wrap form content in `<form>`**: Enter in any single-line input runs the primary action (the sheet requests the
    submit itself; textareas keep Enter for newlines). If you add your own `submit` listener and call `preventDefault()`,
    you own it.
  - `icon` + `accent: '--food'` give the header a tinted icon chip — use the module's icon/colour for editors.
  - `content` may be a function `(api) => Node`. Sheets live on `<body>`, outside your view: they survive re-renders.
- `chips()` single-select **deselects when the selected chip is tapped again** (`onChange(null)`); pass `deselect: false` for
  required choices. Multi-select returns values in option order. Options can be strings, `{value,label,emoji,icon,color}`
  or settings categories `{id,name,emoji,color}` directly.
- `select()` / `segmented()` / `chips()` hand back the **original option values** (numbers stay numbers, `null` stays `null`).
- `stepper`, `ratingInput`, `moodPicker`, `moneyInput` give `null` when cleared — store `null`, not `0`.
- `ratingInput`/`moodPicker` clear on a second tap of the same value.
- Never put user text in `html:`. Text children and `text:` are always safe.
- `toast()` shows max 3; use `{ action: { label: 'Undo', onClick } }` for undo-style actions (or just `removeWithUndo`).
- `confirmDialog()` default is a destructive "Delete" — pass `danger: false, confirmLabel: 'OK'` for neutral questions.

**Data**
- `db.put()` **returns a new object** (with `id`, `createdAt`, `updatedAt`) and never mutates your input — use the return
  value (`const saved = await db.put(...)`), don't expect `record.id` to appear on the object you passed.
- `'db:change'` fires **after the transaction commits** (reading inside the listener sees the new data). Always also handle
  **`store === '*'`** (backup import / clear-all) — every view must refresh on it.
- `byRange(store, from, to)` is **inclusive** on both ends; `byDate` = `byRange(d, d)`.
- `db.patchDay(date, patch)` deep-merges: nested objects merge (`{ checks: { [goalId]: true } }` keeps other checks,
  `{ trading: { review } }` keeps the plan), **arrays and primitives replace**, `undefined` is ignored, `null` clears.
  Read + write happen in one transaction (safe for rapid autosave). `getDay()` always returns full defaults.
- `getSettings()` works before `loadSettings()` (returns defaults) but **never mutate it** — call `updateSettings(patch)`.
  `updateSettings` deep-merges objects but **arrays replace**: to add a setup send the whole array:
  `updateSettings({ trading: { setups: [...getSettings().trading.setups, 'ORB'] } })`.
- Category lookups (`expenseCategory(id)` etc.) **never return null**: unknown ids give a fallback (the 'other' category's
  look) with `missing: true` and the original `id`. `tradingAccount(id)` likewise.
- Records you create should not set `sample: true` (that flag marks generated demo data for removal).
- Trades: always `prepareTrade()` before `db.put('trades', …)`; never compute P&L yourself.
- `imagePicker` stores files as soon as they're picked. If the user cancels a **new** record's editor, `deleteImage()` the ids
  you collected; on delete use `removeWithUndo(store, rec, { files: [...] })`.

**Formatting**
- Money: `fmtMoney(n)` (app currency), `fmtTradeMoney(n)` (trading currency — use for every trade P&L), `{sign: true}` for
  P&L (`+₹1,200` / `−₹300`, true minus U+2212). The sign is glued to the symbol with an invisible **U+2060 word joiner**,
  so don't compare money strings with `===`; use `.includes()`/regex or strip `⁠`.
- `fmtPercent(0.523)` → "52.3%" — **pass fractions**, never 52.3. `fmtR(1.8)` → "+1.8R" (always signed).
- `null` / `undefined` / `''` / `NaN` → `'—'` everywhere (dates: `'—'`, `fmtTime`: `''`). Don't pre-check.
- Colour is never the only signal: pair `.text-profit/.text-loss` (or `tone`) with a signed number.

**Charts**
- `yFormat` / `valueFormat` / `xFormat` are called as `fn(value, ctx)` where `ctx` is option-shaped (`{axis, compact, step}`),
  so **`yFormat: fmtMoney` / `fmtTradeMoney` / `fmtNumber` work directly**. Don't pass `fmtPercent` directly if your data
  isn't fractions.
- Axes should stay unsigned; for signed tooltips use **`tooltipFormat: (v) => fmtTradeMoney(v, { sign: true })`**.
- A chart placed on `--surface-2` (or any non-`--surface` background) needs `style: { '--chart-surface': 'var(--surface-2)' }`
  on a wrapper so dot rings / label halos match the background.
- Charts measure their container: render them into an element that is (or will be) in the DOM with a width; they resize
  themselves. To change data call `chart.update({ data })` or rebuild.

**Rendering & lifecycle**
- `render(root, ctx)` may be async; mount quickly (skeleton/empty state), then fill. Return a **cleanup** function that
  removes every bus listener, timer, and window/document listener you added. A render that finishes after the user left
  is discarded and its cleanup is run for you.
- Re-render on change — the pattern:
  ```js
  const refresh = debounce(draw, 60);
  const offs = [on('db:change', (e) => { if (e.store === 'food' || e.store === 'days' || e.store === '*') refresh(); }),
                on('settings:change', refresh)];
  return () => { disposed = true; refresh.cancel(); offs.forEach((off) => off()); };
  ```
  Keep the page header and nav controls outside the part you re-draw (focus stays put); guard async draws with a
  `disposed` flag.
- Exactly **one `<h1>`** per page — use `pageHeader()`. `ctx.setTitle(text)` changes the tab/top-bar title.
- Date default for new records: `opts.date || state.date || todayKey()`; time: `nowTime()` only when that date is today.
- Icons inside your own markup get classes `icon icon-<name>`. **Never name your own classes `icon-<something>`**
  (`.icon-check`, `.icon-x` …) — they would also match icons. `.icon` has zero specificity (`:where`), so `.my-row .icon { … }`
  always wins.
- Don't add global keyboard shortcuts for `n`, `/`, `?`, `g` (the shell owns them; they're ignored while typing or
  while a sheet is open).

**Manifest shortcuts (`?new=1`)**
- The installed-app shortcuts open `#/expenses?new=1`, `#/food?new=1`, `#/trades?new=1`. Those modules **must** open their
  add editor when `ctx.route.query.new === '1'` and then strip the query:
  `openEditor(null, { date }); ctx.navigate(ctx.route.path, { replace: true });` — the route re-renders once without the
  query (the sheet lives on `<body>` and stays open). `{ silent: true }` instead only rewrites the URL without re-rendering.
  For trades `ctx.route.path` is `'/trades'` (sub-routes keep their own path).

**Testing with smoke**
- `python tools/smoke.py --port 8206 --onboarded --routes "#/food" --shots <dir>` — `--onboarded` skips the welcome
  redirect; `--mobile`, `--theme dark`, `--full`, `--page tools/styleguide.html` are available.
- Seed data in a run with `--eval` (async body, `window.daybook` is ready):
  `--eval "await window.daybook.db.put('food', {date: window.daybook.state.date, time: '13:10', meal: 'lunch', title: 'Dal rice', calories: 520})"`
  `window.daybook` = `{ db, getSettings, updateSettings, navigate, bus:{on,emit}, state, getModules, getModule, openQuickAdd, currentRoute, version, installPrompt }`.
  In the Python API use `page.evaluate("async () => { await window.daybook.db.put(...) }")`.
- `--sample` imports `js/modules/sample-data.js` and runs `loadSampleData()` — it only works once that module exists.
- Until every module exists you will see `HTTP 404` for missing `js/modules/*` and `css/modules/*` files and a
  `[daybook] module "x" failed to load` console error per missing module — those are expected; anything else is a bug.
- Exit code 1 = any console error / page error / HTTP ≥ 400. A `Service Worker registration blocked by Playwright`
  warning is normal (pass `--sw` to allow the worker).
- **Git Bash rewrites `"#/today"` into `#C:/Program Files/Git/today`** (MSYS path conversion) and you silently test the
  fallback route. Prefix the command with `MSYS_NO_PATHCONV=1`, or run it from PowerShell / cmd.

---------------------------------------------------------------------------------------------------------

## 5. How to build a module — skeleton (verified)

This exact file was dropped in as `js/modules/food.js` and smoke-tested on phone and desktop: route renders one `<h1>`,
quick-add tile opens the editor, Enter with an empty title shows the inline error, Enter after typing saves + toasts,
the list refreshes from `db:change`, edit → Delete → Undo restores, `summarizeDay`/`search` return data, `#/food?new=1`
opens the editor and strips the query, zero unexpected console errors.

```js
// js/modules/<name>.js — minimal module skeleton (SPEC 4.0). Rename the constants, keep the shape.
import { db } from '../core/db.js';
import { on, state } from '../core/bus.js';
import { todayKey, nowTime, fmtTime, relativeDay } from '../core/dates.js';
import { plural } from '../core/format.js';
import { h, mount, pageHeader, card, listItem, emptyState, dateNav, openSheet, field, input, textarea, toast, debounce } from '../core/ui.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'food'; // = route segment = registry id
const TITLE = 'Food';
const ICON = 'food'; // icons.js name
const COLOR = '--food'; // CSS custom property name
const STORE = 'food';

/** Add/edit sheet. record=null → new. Resolves to the saved record, or null when cancelled/deleted. */
function openEditor(record = null, opts = {}) {
  const isNew = !record;
  const date = (record && record.date) || opts.date || state.date || todayKey();
  const draft = { title: '', note: '', ...record, date, time: record ? record.time || '' : date === todayKey() ? nowTime() : '' };

  const titleIn = input({ value: draft.title, placeholder: 'What did you eat?', autocomplete: 'off', onInput: (e) => { draft.title = e.target.value; titleField.setError(null); } });
  const titleField = field('Title', titleIn, { required: true });
  const noteIn = textarea({ value: draft.note, rows: 2, onInput: (e) => { draft.note = e.target.value; } });
  const dateIn = input({ type: 'date', value: draft.date, max: todayKey(), onChange: (e) => { draft.date = e.target.value || date; } });
  const timeIn = input({ type: 'time', value: draft.time, onChange: (e) => { draft.time = e.target.value; } });

  // Wrap the body in a <form>: Enter in any single-line input runs the primary (Save) action.
  const form = h('form.stack', titleField, field('Note', noteIn), h('div.form-grid', field('Date', dateIn), field('Time', timeIn)));

  const sheet = openSheet({
    title: isNew ? 'Add meal' : 'Edit meal',
    icon: ICON, // header icon chip, tinted by accent
    accent: COLOR,
    content: form,
    initialFocus: isNew ? titleIn : null,
    actions: [
      !isNew && {
        label: 'Delete', variant: 'danger', icon: 'trash', // danger actions sit on the left
        onClick: async () => { await removeWithUndo(STORE, record, { label: 'Meal deleted' }); return null; },
      },
      { label: 'Cancel', variant: 'secondary' }, // no onClick → closes with null
      {
        label: 'Save', variant: 'primary',
        onClick: async () => {
          if (!draft.title.trim()) {
            titleField.setError('Give it a short name');
            titleIn.focus();
            return false; // false keeps the sheet open
          }
          const saved = await db.put(STORE, { ...draft, title: draft.title.trim() }); // → NEW object with id/createdAt/updatedAt
          toast('Saved', { type: 'success' });
          return saved; // becomes sheet.result
        },
      },
    ].filter(Boolean),
  });
  return sheet.result;
}

async function render(root, ctx) {
  let date = state.date || todayKey();
  let disposed = false;

  const list = h('div.section'); // only this part re-renders; header + date nav stay (keeps focus)
  mount(
    root,
    h(
      'div.page.food-page',
      pageHeader({ title: TITLE, subtitle: 'What you ate today', actions: [{ label: 'Add', icon: 'plus', variant: 'primary', onClick: () => openEditor(null, { date }) }] }),
      dateNav(date, (d) => { date = d; draw(); }),
      list
    )
  );

  async function draw() {
    const items = await db.byDate(STORE, date); // sorted by date, time, createdAt
    if (disposed) return; // the user navigated away while we were reading
    mount(
      list,
      items.length
        ? card({
            title: relativeDay(date),
            subtitle: plural(items.length, 'meal'),
            flush: true,
            children: h('div.list', items.map((r) => listItem({ icon: ICON, accent: COLOR, title: r.title, meta: [fmtTime(r.time), r.note], chevron: true, onClick: () => openEditor(r) }))),
          })
        : emptyState({ icon: ICON, accent: COLOR, title: 'No meals yet', message: 'Log what you eat — it takes ten seconds.', action: { label: 'Add a meal', icon: 'plus', onClick: () => openEditor(null, { date }) } })
    );
  }
  await draw();

  // Re-render on data/settings changes; '*' = import / clear-all.
  const refresh = debounce(draw, 60);
  const offs = [
    on('db:change', (e) => { if (e.store === STORE || e.store === '*') refresh(); }),
    on('settings:change', refresh),
  ];

  // Manifest shortcut / deep link: #/food?new=1 opens the editor, then drop the query.
  if (ctx.route.query.new === '1') {
    openEditor(null, { date });
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => { disposed = true; refresh.cancel(); offs.forEach((off) => off()); };
}

export default {
  id: ID,
  title: TITLE,
  icon: ICON,
  color: COLOR,
  render,
  openEditor,
  quickActions: [{ id: 'meal', label: 'Meal', icon: ICON, color: COLOR, run: ({ date }) => openEditor(null, { date }) }],

  async summarizeDay(date) {
    const items = await db.byDate(STORE, date);
    return {
      id: ID, title: TITLE, icon: ICON, color: COLOR,
      headline: items.length ? plural(items.length, 'meal') : '',
      empty: 'No meals yet',
      items: items.map((r) => ({ id: r.id, time: r.time, title: r.title, meta: fmtTime(r.time), onOpen: () => openEditor(r) })),
      addLabel: 'Add meal',
      onAdd: () => openEditor(null, { date }),
    };
  },

  async search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const all = await db.all(STORE);
    return all
      .filter((r) => [r.title, r.note].some((s) => String(s || '').toLowerCase().includes(q)))
      .reverse() // newest first
      .slice(0, 50)
      .map((r) => ({ id: r.id, module: ID, icon: ICON, color: COLOR, title: r.title, subtitle: r.note || fmtTime(r.time), date: r.date, onOpen: () => openEditor(r) }));
  },
};
```

Notes on the skeleton: `quickActions` may also be a function returning the array (the shell accepts both);
`summarizeDay`/`search` are only needed for daily modules + trades (and search for anything searchable); keep editors
in the module (or `trades/editor.js`) so Today, Search and quick-add can all call `getModule(id).openEditor(record)`.
