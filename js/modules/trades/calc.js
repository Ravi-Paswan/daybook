// Trade math — pure functions, no DOM, no DB. Single source of truth for every P&L number in the app.
//
// Conventions
//   gross  = (exit − entry) × qty × multiplier × (long ? +1 : −1)
//   net    = pnlOverride ?? gross − fees
//   risk   = |entry − stop| × qty × multiplier   (only when the stop is on the losing side of entry)
//   R      = net / risk
//   return = net / (entry × qty × multiplier)    (a fraction; format with fmtPercent)
// Only CLOSED trades have P&L. Open trades return null for P&L-derived values.

const EPS = 1e-9;

/** Coerce '' / null / undefined / NaN → null, else Number. */
export function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Round away binary float noise (0.1 + 0.2) while keeping 8 decimals of precision. */
export function round8(v) {
  return v === null ? null : Math.round(v * 1e8) / 1e8;
}

export function isClosed(t) {
  return !!t && t.status === 'closed';
}

export function isOpen(t) {
  return !!t && t.status !== 'closed';
}

export function dirSign(t) {
  return t && t.direction === 'short' ? -1 : 1;
}

function mult(t) {
  const m = num(t.multiplier);
  return m && m > 0 ? m : 1;
}

/** Gross P&L before fees (closed trades only). */
export function tradeGross(t) {
  if (!isClosed(t)) return null;
  const e = num(t.entryPrice);
  const x = num(t.exitPrice);
  const q = num(t.quantity);
  if (e === null || x === null || q === null) return null;
  return round8((x - e) * Math.abs(q) * mult(t) * dirSign(t));
}

/** Net P&L after fees, or the manual override (closed trades only). */
export function tradeNet(t) {
  if (!isClosed(t)) return null;
  const o = num(t.pnlOverride);
  if (o !== null) return round8(o);
  const g = tradeGross(t);
  if (g === null) return null;
  return round8(g - (num(t.fees) || 0));
}

/** Initial money at risk based on the stop loss (works for open and closed trades). */
export function tradeRisk(t) {
  if (!t) return null;
  const e = num(t.entryPrice);
  const s = num(t.stopLoss);
  const q = num(t.quantity);
  if (e === null || s === null || q === null) return null;
  const perUnit = (e - s) * dirSign(t); // positive when stop is on the losing side
  if (perUnit <= EPS) return null;
  return round8(perUnit * Math.abs(q) * mult(t));
}

/** Realised R-multiple (net / initial risk). */
export function tradeR(t) {
  const net = tradeNet(t);
  const risk = tradeRisk(t);
  if (net === null || risk === null || risk <= EPS) return null;
  return net / risk;
}

/** Planned reward:risk from target and stop (e.g. 2.5 means 1 : 2.5). */
export function plannedRR(t) {
  if (!t) return null;
  const e = num(t.entryPrice);
  const s = num(t.stopLoss);
  const tg = num(t.target);
  if (e === null || s === null || tg === null) return null;
  const risk = (e - s) * dirSign(t);
  const reward = (tg - e) * dirSign(t);
  if (risk <= EPS || reward <= EPS) return null;
  return reward / risk;
}

/** Potential profit at target (money), before fees. */
export function potentialReward(t) {
  if (!t) return null;
  const e = num(t.entryPrice);
  const tg = num(t.target);
  const q = num(t.quantity);
  if (e === null || tg === null || q === null) return null;
  const perUnit = (tg - e) * dirSign(t);
  if (perUnit <= EPS) return null;
  return round8(perUnit * Math.abs(q) * mult(t));
}

/** Position notional at entry (money). */
export function notional(t) {
  if (!t) return null;
  const e = num(t.entryPrice);
  const q = num(t.quantity);
  if (e === null || q === null) return null;
  return round8(Math.abs(e * q * mult(t)));
}

/** Return on position notional as a fraction (closed trades only). */
export function tradeReturnPct(t) {
  const net = tradeNet(t);
  const n = notional(t);
  if (net === null || !n) return null;
  return net / n;
}

function toStamp(date, time) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  let hh = 0;
  let mm = 0;
  if (time && /^\d{1,2}:\d{2}/.test(time)) {
    [hh, mm] = time.split(':').map(Number);
  }
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/** Holding time in minutes (closed trades with an exit date). */
export function holdMinutes(t) {
  if (!isClosed(t)) return null;
  // a missing time would count from/to midnight — only measure when the times are known
  if (!t.entryTime || (!t.exitTime && (!t.exitDate || t.exitDate === t.entryDate))) return null;
  const a = toStamp(t.entryDate, t.entryTime);
  const b = toStamp(t.exitDate || t.entryDate, t.exitTime);
  if (a === null || b === null) return null;
  const mins = Math.round((b - a) / 60000);
  return mins >= 0 ? mins : null;
}

/** 'win' | 'loss' | 'breakeven' | 'open' | 'unknown' */
export function outcome(t) {
  if (!isClosed(t)) return 'open';
  const net = tradeNet(t);
  if (net === null) return 'unknown';
  if (Math.abs(net) < EPS) return 'breakeven';
  return net > 0 ? 'win' : 'loss';
}

/** Sort key: closing moment for closed trades, entry moment for open ones. */
export function tradeSortKey(t) {
  const closed = isClosed(t);
  const d = (closed ? t.exitDate || t.entryDate : t.entryDate) || t.date || '';
  const tm = (closed ? t.exitTime || t.entryTime : t.entryTime) || '00:00';
  return `${d}T${tm}|${t.createdAt || ''}`;
}

export function sortTrades(trades, dir = 'asc') {
  const out = [...trades].sort((a, b) => (tradeSortKey(a) < tradeSortKey(b) ? -1 : tradeSortKey(a) > tradeSortKey(b) ? 1 : 0));
  return dir === 'desc' ? out.reverse() : out;
}

/**
 * Normalise a trade before saving: trims/uppercases symbol, coerces numbers, sets the index `date`,
 * clears exit fields for open trades. Returns a NEW object.
 */
export function prepareTrade(input) {
  const t = { ...input };
  t.symbol = String(t.symbol || '').trim().toUpperCase();
  t.direction = t.direction === 'short' ? 'short' : 'long';
  t.status = t.status === 'closed' ? 'closed' : 'open';
  for (const k of ['entryPrice', 'exitPrice', 'quantity', 'multiplier', 'fees', 'stopLoss', 'target', 'pnlOverride']) {
    t[k] = num(t[k]);
  }
  if (t.multiplier === null || t.multiplier <= 0) t.multiplier = 1;
  if (t.fees === null) t.fees = 0;
  for (const k of ['emotions', 'mistakes', 'tags', 'screenshots']) {
    t[k] = Array.isArray(t[k]) ? t[k] : [];
  }
  if (t.status === 'open') {
    t.exitPrice = null;
    t.exitDate = null;
    t.exitTime = null;
    t.pnlOverride = null;
    t.date = t.entryDate;
  } else {
    if (!t.exitDate) t.exitDate = t.entryDate;
    t.date = t.exitDate || t.entryDate;
  }
  return t;
}

/** Closed trades that have a computable net P&L, in chronological order. */
export function closedWithPnl(trades) {
  return sortTrades(trades.filter((t) => isClosed(t) && tradeNet(t) !== null));
}

/**
 * Aggregate statistics for a set of trades. Open trades are counted in `open` but excluded from P&L stats.
 * Percent-like values are fractions. Money values are in the trading currency.
 */
export function computeStats(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const closed = closedWithPnl(list);
  const open = list.filter(isOpen).length;
  const s = {
    count: closed.length,
    open,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null,
    net: 0,
    grossProfit: 0,
    grossLoss: 0, // positive magnitude
    fees: 0,
    profitFactor: null,
    avgWin: null,
    avgLoss: null, // positive magnitude
    payoffRatio: null,
    expectancy: null,
    avgR: null,
    totalR: 0,
    rCount: 0,
    best: null, // trade
    worst: null, // trade
    largestWin: null,
    largestLoss: null, // negative number
    maxWinStreak: 0,
    maxLossStreak: 0,
    currentStreak: { type: null, count: 0 },
    maxDrawdown: 0, // positive magnitude, money
    avgHoldMinutes: null,
  };
  if (!closed.length) {
    s.fees = round8(list.reduce((a, t) => a + (isClosed(t) ? num(t.fees) || 0 : 0), 0));
    return s;
  }
  let holdSum = 0;
  let holdCount = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let equity = 0;
  let peak = 0;
  for (const t of closed) {
    const net = tradeNet(t);
    s.net += net;
    s.fees += num(t.pnlOverride) !== null ? 0 : num(t.fees) || 0;
    const o = outcome(t);
    if (o === 'win') {
      s.wins++;
      s.grossProfit += net;
      winStreak++;
      lossStreak = 0;
    } else if (o === 'loss') {
      s.losses++;
      s.grossLoss += -net;
      lossStreak++;
      winStreak = 0;
    } else {
      s.breakeven++;
      winStreak = 0;
      lossStreak = 0;
    }
    s.maxWinStreak = Math.max(s.maxWinStreak, winStreak);
    s.maxLossStreak = Math.max(s.maxLossStreak, lossStreak);
    if (!s.best || net > tradeNet(s.best)) s.best = t;
    if (!s.worst || net < tradeNet(s.worst)) s.worst = t;
    const r = tradeR(t);
    if (r !== null) {
      s.totalR += r;
      s.rCount++;
    }
    const hm = holdMinutes(t);
    if (hm !== null) {
      holdSum += hm;
      holdCount++;
    }
    equity += net;
    peak = Math.max(peak, equity);
    s.maxDrawdown = Math.max(s.maxDrawdown, peak - equity);
  }
  const last = closed[closed.length - 1];
  const lastO = outcome(last);
  s.currentStreak = lastO === 'win' ? { type: 'win', count: winStreak } : lastO === 'loss' ? { type: 'loss', count: lossStreak } : { type: null, count: 0 };
  s.net = round8(s.net);
  s.grossProfit = round8(s.grossProfit);
  s.grossLoss = round8(s.grossLoss);
  s.fees = round8(s.fees);
  s.maxDrawdown = round8(s.maxDrawdown);
  s.winRate = s.wins / s.count;
  s.profitFactor = s.grossLoss > EPS ? s.grossProfit / s.grossLoss : s.grossProfit > EPS ? Infinity : null;
  s.avgWin = s.wins ? s.grossProfit / s.wins : null;
  s.avgLoss = s.losses ? s.grossLoss / s.losses : null;
  s.payoffRatio = s.avgWin !== null && s.avgLoss ? s.avgWin / s.avgLoss : null;
  s.expectancy = s.net / s.count;
  s.avgR = s.rCount ? s.totalR / s.rCount : null;
  s.largestWin = s.best && tradeNet(s.best) > 0 ? tradeNet(s.best) : null;
  s.largestLoss = s.worst && tradeNet(s.worst) < 0 ? tradeNet(s.worst) : null;
  s.avgHoldMinutes = holdCount ? holdSum / holdCount : null;
  return s;
}

/**
 * Equity curve over closed trades in chronological order.
 * → [{ trade, date, pnl, equity, peak, drawdown }]  (equity starts from `start`, which is not itself a point)
 */
export function equitySeries(trades, { start = 0 } = {}) {
  let equity = num(start) || 0;
  let peak = equity;
  return closedWithPnl(trades).map((t) => {
    const pnl = tradeNet(t);
    equity = round8(equity + pnl);
    peak = Math.max(peak, equity);
    return { trade: t, date: t.date, pnl, equity, peak, drawdown: round8(peak - equity) };
  });
}

/** Net P&L per day (closed trades, keyed by trade.date). → {[date]: {pnl, count, wins, losses}} */
export function dailyPnl(trades) {
  const out = {};
  for (const t of closedWithPnl(trades)) {
    const d = t.date;
    if (!out[d]) out[d] = { pnl: 0, count: 0, wins: 0, losses: 0 };
    const net = tradeNet(t);
    out[d].pnl = round8(out[d].pnl + net);
    out[d].count++;
    const o = outcome(t);
    if (o === 'win') out[d].wins++;
    else if (o === 'loss') out[d].losses++;
  }
  return out;
}

/**
 * Group trades and compute stats per group.
 * keyFn(trade) → string | string[] (multi-valued, e.g. mistakes) | null/'' (skipped unless `emptyLabel` given).
 * → [{ key, trades, ...computeStats(trades) }] sorted by net desc (or `sort: 'count'`).
 */
export function groupStats(trades, keyFn, { emptyLabel = null, sort = 'net' } = {}) {
  const groups = new Map();
  for (const t of trades) {
    let keys = keyFn(t);
    if (!Array.isArray(keys)) keys = [keys];
    keys = keys.filter((k) => k !== null && k !== undefined && k !== '');
    if (!keys.length) {
      if (emptyLabel === null) continue;
      keys = [emptyLabel];
    }
    for (const k of new Set(keys)) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
  }
  const rows = [...groups.entries()].map(([key, list]) => ({ key, trades: list, ...computeStats(list) }));
  rows.sort(sort === 'count' ? (a, b) => b.count - a.count : (a, b) => b.net - a.net);
  return rows;
}

/**
 * R-multiple histogram buckets.
 * → [{ label, from, to, count }] — from/to are -Infinity/Infinity at the ends.
 */
export function rDistribution(trades, edges = [-3, -2, -1, 0, 1, 2, 3]) {
  const rs = closedWithPnl(trades).map(tradeR).filter((r) => r !== null);
  const buckets = [];
  const fmt = (v) => (v > 0 ? `+${v}R` : `${v}R`).replace('-', '−');
  buckets.push({ label: `< ${fmt(edges[0])}`, from: -Infinity, to: edges[0], count: 0 });
  for (let i = 0; i < edges.length - 1; i++) {
    buckets.push({ label: `${fmt(edges[i])} to ${fmt(edges[i + 1])}`, from: edges[i], to: edges[i + 1], count: 0 });
  }
  buckets.push({ label: `> ${fmt(edges[edges.length - 1])}`, from: edges[edges.length - 1], to: Infinity, count: 0 });
  for (const r of rs) {
    const b = buckets.find((bk) => r >= bk.from && r < bk.to) || buckets[buckets.length - 1];
    b.count++;
  }
  return buckets;
}

export const MARKET_LABELS = {
  stocks: 'Stocks',
  options: 'Options',
  futures: 'Futures',
  forex: 'Forex',
  crypto: 'Crypto',
  commodities: 'Commodities',
  other: 'Other',
};

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
