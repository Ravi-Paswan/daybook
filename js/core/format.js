// Number / money / duration formatting (SPEC 3.8).
// - Null / undefined / '' / NaN → '—'.
// - Negative numbers always use the true minus sign U+2212 ('−₹300'); `sign:true` also adds '+' to positives.
//   A value that rounds to zero is shown unsigned. fmtMoney glues the sign to a leading currency symbol with an
//   invisible U+2060 WORD JOINER ('−⁠₹300') so a line never breaks between them — compare money strings with
//   .includes() / a regex, or strip it: s.replace(/⁠/g, '').
// - Money default decimals: 0 when the value is an integer or |n| ≥ 1000, else 2 (capped at the currency's
//   own minor units, e.g. JPY → 0). Pass `decimals` to override. `compact` uses Intl compact notation
//   (en-IN → '₹1.2L', en-US → '$1.2K').
// - Intl formatters are cached per (locale, currency, options).
// Extras beyond the spec: tradeCurrency(), fmtTradeMoney(), guessCurrency(locale), plural(),
// fmtNumber option `maxDecimals` (trimmed), fmtR option `decimals`, toNumber().

import { getSettings } from './settings.js';

export const CURRENCIES = [
  { code: 'INR', name: 'Indian rupee' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'KRW', name: 'South Korean won' },
  { code: 'IDR', name: 'Indonesian rupiah' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'VND', name: 'Vietnamese dong' },
  { code: 'PKR', name: 'Pakistani rupee' },
  { code: 'BDT', name: 'Bangladeshi taka' },
  { code: 'LKR', name: 'Sri Lankan rupee' },
  { code: 'NPR', name: 'Nepalese rupee' },
  { code: 'SAR', name: 'Saudi riyal' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'NGN', name: 'Nigerian naira' },
  { code: 'KES', name: 'Kenyan shilling' },
  { code: 'EGP', name: 'Egyptian pound' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'RUB', name: 'Russian ruble' },
];

const MINUS = '−';
const DASH = '—';
const WJ = '⁠'; // WORD JOINER: forbids a line break between a sign and a currency symbol

function locale() {
  try {
    return (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || 'en-US';
  } catch {
    return 'en-US';
  }
}

/** Coerce to a finite number or null ('' / null / undefined / NaN / non-numeric → null). */
export function toNumber(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isNaN(n) ? null : n;
}

const nearInt = (v) => Math.abs(v - Math.round(v)) < 1e-9;

function settings() {
  try {
    return getSettings() || {};
  } catch {
    return {};
  }
}

function appCurrency() {
  return settings().currency || 'USD';
}

export function tradeCurrency() {
  const s = settings();
  return (s.trading && s.trading.currency) || s.currency || 'USD';
}

// ---------------------------------------------------------------------------------------------------
// Formatter cache

const cache = new Map();

function nf(opts, loc = locale()) {
  const id = loc + '|' + JSON.stringify(opts);
  let f = cache.get(id);
  if (f) return f;
  try {
    f = new Intl.NumberFormat(loc, opts);
  } catch (err) {
    // Old engines: narrowSymbol unsupported → plain symbol; unknown currency → rethrow for the caller.
    if (opts.currencyDisplay === 'narrowSymbol') {
      f = nf({ ...opts, currencyDisplay: 'symbol' }, loc);
    } else if (opts.notation) {
      const { notation, compactDisplay, ...rest } = opts;
      f = nf(rest, loc);
    } else {
      throw err;
    }
  }
  cache.set(id, f);
  return f;
}

const digitsCache = new Map();
function currencyDigits(code) {
  if (digitsCache.has(code)) return digitsCache.get(code);
  let d = 2;
  try {
    d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    d = 2;
  }
  digitsCache.set(code, d);
  return d;
}

function applySign(v, body, sign, maxFrac) {
  const zero = Math.abs(v) < 0.5 * Math.pow(10, -maxFrac);
  if (zero) return body;
  if (v < 0) return MINUS + body;
  return sign ? '+' + body : body;
}

function fmtPlain(abs, minFrac, maxFrac, compact) {
  const opts = { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac };
  if (compact) {
    opts.notation = 'compact';
    opts.compactDisplay = 'short';
  }
  return nf(opts).format(abs);
}

// ---------------------------------------------------------------------------------------------------
// Public formatters

export function fmtMoney(n, { sign = false, compact = false, decimals, currency } = {}) {
  const v = toNumber(n);
  if (v === null) return DASH;
  if (!Number.isFinite(v)) return (v < 0 ? MINUS : sign ? '+' : '') + '∞';
  const code = String(currency || appCurrency()).toUpperCase();
  const abs = Math.abs(v);
  const useCompact = compact && abs >= 1000;
  let minFrac;
  let maxFrac;
  if (useCompact) {
    minFrac = 0;
    maxFrac = decimals ?? 1;
  } else if (decimals !== undefined && decimals !== null) {
    minFrac = maxFrac = Math.max(0, Math.min(20, Math.trunc(decimals)));
  } else {
    const d = nearInt(v) || abs >= 1000 ? 0 : 2;
    minFrac = maxFrac = Math.min(d, currencyDigits(code));
  }
  let body;
  try {
    const opts = {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    };
    if (useCompact) {
      opts.notation = 'compact';
      opts.compactDisplay = 'short';
    }
    body = nf(opts).format(abs);
  } catch {
    body = `${code} ${fmtPlain(abs, minFrac, maxFrac, useCompact)}`; // unknown currency code
  }
  const out = applySign(v, body, sign, useCompact ? 3 : maxFrac);
  // '−₹300' / '+$5': glue the sign to a leading currency symbol (sign + digit never breaks, so no joiner there).
  return out !== body && !/^[+−]\d/.test(out) ? out[0] + WJ + out.slice(1) : out;
}

/** fmtMoney in the trading currency (settings.trading.currency || settings.currency). */
export function fmtTradeMoney(n, opts = {}) {
  // Traders need exact figures: keep paise/cents on non-integer amounts even above 1,000 (unless compact or caller overrides).
  const o = { ...opts, currency: opts.currency || tradeCurrency() };
  const v = Number(n);
  if (o.decimals === undefined && !o.compact && Number.isFinite(v) && Math.abs(v - Math.round(v)) > 1e-9) o.decimals = 2;
  return fmtMoney(n, o);
}

/**
 * fmtNumber(1234.5) → '1,235'; fmtNumber(7.25) → '7.25'; fmtNumber(7.5, {decimals:2}) → '7.50'.
 * Default: 0 decimals for integers / |n| ≥ 1000, else up to 2 (trailing zeros trimmed).
 */
export function fmtNumber(n, { decimals, compact = false, sign = false, maxDecimals } = {}) {
  const v = toNumber(n);
  if (v === null) return DASH;
  if (!Number.isFinite(v)) return (v < 0 ? MINUS : sign ? '+' : '') + '∞';
  const abs = Math.abs(v);
  let minFrac;
  let maxFrac;
  const useCompact = compact && abs >= 1000;
  if (useCompact) {
    minFrac = 0;
    maxFrac = decimals ?? maxDecimals ?? 1;
  } else if (decimals !== undefined && decimals !== null) {
    minFrac = maxFrac = Math.max(0, Math.min(20, Math.trunc(decimals)));
  } else if (maxDecimals !== undefined && maxDecimals !== null) {
    minFrac = 0;
    maxFrac = Math.max(0, Math.min(20, Math.trunc(maxDecimals)));
  } else {
    minFrac = 0;
    maxFrac = nearInt(v) || abs >= 1000 ? 0 : 2;
  }
  return applySign(v, fmtPlain(abs, minFrac, maxFrac, useCompact), sign, useCompact ? 3 : maxFrac);
}

/** Prices: up to 8 decimals, trailing zeros trimmed (1.5000 → '1.5', 0.00001234 → '0.00001234'). */
export function fmtPrice(n) {
  const v = toNumber(n);
  if (v === null || !Number.isFinite(v)) return DASH;
  return applySign(v, fmtPlain(Math.abs(v), 0, 8, false), false, 8);
}

/** Fractions → percent: 0.523 → '52.3%', 0.5 → '50%' (trailing zeros trimmed). */
export function fmtPercent(fraction, { decimals = 1, sign = false } = {}) {
  const v = toNumber(fraction);
  if (v === null) return DASH;
  if (!Number.isFinite(v)) return (v < 0 ? MINUS : sign ? '+' : '') + '∞';
  const d = Math.max(0, Math.min(20, Math.trunc(decimals ?? 1)));
  const body = nf({ style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: d }).format(Math.abs(v));
  return applySign(v, body, sign, d + 2);
}

/** Minutes → '45m', '1h 20m', '2h', '3d 4h'. */
export function fmtDuration(minutes) {
  const v = toNumber(minutes);
  if (v === null || !Number.isFinite(v)) return DASH;
  let m = Math.round(Math.abs(v));
  let s;
  if (m < 60) s = `${m}m`;
  else if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    s = r ? `${h}h ${r}m` : `${h}h`;
  } else {
    let d = Math.floor(m / 1440);
    let h = Math.round((m % 1440) / 60);
    if (h === 24) {
      d += 1;
      h = 0;
    }
    s = h ? `${d}d ${h}h` : `${d}d`;
  }
  return v < 0 && m > 0 ? MINUS + s : s;
}

/** R-multiple: '+1.8R' / '−0.5R' / '0.0R'. */
export function fmtR(r, { decimals = 1 } = {}) {
  const v = toNumber(r);
  if (v === null || !Number.isFinite(v)) return DASH;
  const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const body = fmtPlain(Math.abs(v), d, d, false) + 'R';
  return applySign(v, body, true, d);
}

/** 'profit' | 'loss' | 'neutral' */
export function pnlTone(n) {
  const v = toNumber(n);
  if (v === null || Math.abs(v) < 1e-9) return 'neutral';
  return v > 0 ? 'profit' : 'loss';
}

const symCache = new Map();
/** '₹', '$', '€' … (narrow symbol; falls back to the code). */
export function currencySymbol(code) {
  const c = String(code || appCurrency()).toUpperCase();
  const id = locale() + '|' + c;
  if (symCache.has(id)) return symCache.get(id);
  let sym = c;
  try {
    const part = nf({ style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    if (part && part.value) sym = part.value;
  } catch {
    sym = c;
  }
  symCache.set(id, sym);
  return sym;
}

export function fmtWeight(n) {
  const v = toNumber(n);
  if (v === null) return DASH;
  const unit = (settings().units && settings().units.weight) || 'kg';
  return `${fmtNumber(v, { maxDecimals: 1 })} ${unit}`;
}

export function fmtDistance(n) {
  const v = toNumber(n);
  if (v === null) return DASH;
  const unit = (settings().units && settings().units.distance) || 'km';
  return `${fmtNumber(v, { maxDecimals: 2 })} ${unit}`;
}

/** plural(3, 'meal') → '3 meals'; plural(1, 'entry', 'entries') → '1 entry'. */
export function plural(n, word, pluralWord) {
  const v = toNumber(n) ?? 0;
  return `${fmtNumber(v)} ${v === 1 ? word : pluralWord || (/[^aeiou]y$/i.test(word) ? word.slice(0, -1) + 'ies' : word + 's')}`;
}

const REGION_CURRENCY = {
  IN: 'INR', US: 'USD', GB: 'GBP', JP: 'JPY', AU: 'AUD', CA: 'CAD', SG: 'SGD', AE: 'AED', CH: 'CHF', LI: 'CHF',
  CN: 'CNY', HK: 'HKD', NZ: 'NZD', ZA: 'ZAR', BR: 'BRL', MX: 'MXN', KR: 'KRW', ID: 'IDR', MY: 'MYR', TH: 'THB',
  PH: 'PHP', VN: 'VND', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR', SA: 'SAR', TR: 'TRY', NG: 'NGN', KE: 'KES',
  EG: 'EGP', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', RU: 'RUB',
};
const EURO = new Set(['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'GR', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'MT', 'CY', 'HR']);

/** Best-guess app currency from a locale ('en-IN' → 'INR', 'de-DE' → 'EUR', 'en' → 'USD'). */
export function guessCurrency(loc = locale()) {
  let region = null;
  try {
    const l = new Intl.Locale(loc);
    region = l.region || (typeof l.maximize === 'function' ? l.maximize().region : null);
  } catch {
    const m = /[-_]([A-Za-z]{2})\b/.exec(String(loc || ''));
    region = m ? m[1].toUpperCase() : null;
  }
  if (!region) return 'USD';
  if (EURO.has(region)) return 'EUR';
  return REGION_CURRENCY[region] || 'USD';
}
