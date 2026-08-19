/* ============================================================================
 * NODE 2/5 — Indicators
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Turns raw Twelve Data responses into the indicator set the scorer consumes.
 * Nothing here makes a decision; it only measures.
 *
 * TWELVE DATA RESPONSE NOTES (these bite if forgotten):
 *   - `values` is NEWEST-FIRST. Everything below reverses to oldest-first
 *     immediately and works chronologically thereafter.
 *   - Every OHLC field is a STRING. parseFloat everywhere.
 *   - No `volume` for metals/forex. Do not depend on it.
 *   - Errors come back HTTP 200 with {status:"error", code, message}.
 *   - Responses are matched to the fetch plan by meta.symbol + meta.interval,
 *     not by item order. Order is not contractual.
 *
 * STALENESS GATE: if the newest 15m bar is older than 60 minutes the market is
 * shut (weekend, holiday, or the DST-straddling hour the cron over-covers).
 * We return [] which ends the run with no post. That is correct behaviour,
 * not a failure.
 * ==========================================================================*/

const MAX_BAR_AGE_MIN = 60;

// ---------------------------------------------------------------- helpers ---

/** Wilder EMA. Seeds from the SMA of the first `period` values. */
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let e = acc / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/** Wilder ATR. bars are oldest-first {high, low, close}. */
function atr(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      ),
    );
  }
  let acc = 0;
  for (let i = 0; i < period; i++) acc += tr[i];
  let a = acc / period;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
  }
  return a;
}

function highest(bars, n, key) {
  const slice = bars.slice(-n);
  return slice.reduce((m, b) => (b[key] > m ? b[key] : m), -Infinity);
}

function lowest(bars, n, key) {
  const slice = bars.slice(-n);
  return slice.reduce((m, b) => (b[key] < m ? b[key] : m), Infinity);
}

function round(n, dp) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * Twelve Data intraday datetime is "YYYY-MM-DD HH:mm:ss" with no zone marker.
 * We request timezone=UTC on the HTTP node, so append Z to parse it as UTC
 * rather than letting the runtime guess local time.
 */
function parseBarTime(dt) {
  if (!dt) return null;
  const iso = dt.length <= 10 ? `${dt}T00:00:00Z` : `${dt.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Normalise one Twelve Data response into oldest-first numeric bars. */
function toBars(body) {
  return body.values
    .map((v) => ({
      t: parseBarTime(v.datetime),
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .filter(
      (b) =>
        b.t !== null &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close),
    )
    .sort((a, b) => a.t - b.t); // oldest-first, explicitly — do not trust order
}

function sessionForHour(h) {
  if (h < 7) return 'asia';
  if (h < 13) return 'london';
  if (h < 17) return 'ny_overlap';
  if (h < 21) return 'ny_afternoon';
  return 'late';
}

// --------------------------------------------------- collect the responses ---

const responses = $input.all();
const plan = $('Build fetch plan').all().map((i) => i.json);

// Keyed "SYMBOL|interval" -> bars
const series = {};

for (const item of responses) {
  const body = item.json || {};

  if (body.status !== 'ok' || !Array.isArray(body.values)) {
    // Surfaces as a workflow error -> error workflow DMs the owner.
    // Common causes: exhausted API credits (429), bad symbol, expired key.
    const detail = body.message || JSON.stringify(body).slice(0, 300);
    throw new Error(`Twelve Data request failed: ${detail}`);
  }

  const sym = body.meta && body.meta.symbol;
  const ivl = body.meta && body.meta.interval;
  if (!sym || !ivl) {
    throw new Error('Twelve Data response missing meta.symbol / meta.interval');
  }

  const bars = toBars(body);
  if (bars.length === 0) {
    throw new Error(`Twelve Data returned no usable bars for ${sym} ${ivl}`);
  }
  series[`${sym}|${ivl}`] = bars;
}

// Display metadata lives in the fetch plan so config stays in exactly one node.
const assetCfg = plan.find((p) => p.role === 'asset');
if (!assetCfg) throw new Error('No asset row found in the fetch plan.');

const SYM = assetCfg.symbol;
const m15 = series[`${SYM}|15min`];
const h1 = series[`${SYM}|1h`];
const d1 = series[`${SYM}|1day`];

const dollarCfg = plan.find((p) => p.role === 'dollar_proxy');
const fx = dollarCfg ? series[`${dollarCfg.symbol}|${dollarCfg.interval}`] : null;

for (const [name, arr] of [['15min', m15], ['1h', h1], ['1day', d1]]) {
  if (!arr) throw new Error(`Missing ${SYM} ${name} series in responses.`);
}

// -------------------------------------------------------- staleness gate ----

const nowMs = Date.now();
const newest15 = m15[m15.length - 1];
const barAgeMin = (nowMs - newest15.t) / 60000;

if (barAgeMin > MAX_BAR_AGE_MIN) {
  const sd = $getWorkflowStaticData('global');
  sd.skipped = (sd.skipped || 0) + 1;
  sd.lastSkipAt = new Date(nowMs).toISOString();
  console.log(
    `Market closed or data stale: newest 15m bar is ${Math.round(barAgeMin)} min old. Skipping run.`,
  );
  return []; // ends the run, posts nothing
}

// ------------------------------------------------------------ indicators ----

const price = newest15.close;
const closes1h = h1.map((b) => b.close);

const ema20 = ema(closes1h, 20);
const ema50 = ema(closes1h, 50);
const ema200 = ema(closes1h, 200); // null if fewer than 200 bars returned
const atr1h = atr(h1, 14);
const atrDaily = atr(d1, 14);

if (!Number.isFinite(atr1h) || atr1h <= 0) {
  throw new Error('ATR(1h) could not be computed — insufficient 1h history.');
}

// Prior completed daily bar. values[0] after sorting is oldest, so the newest
// daily bar is last — and it may be today's still-forming bar.
const todayUTC = new Date(nowMs).toISOString().slice(0, 10);
const newestDaily = d1[d1.length - 1];
const priorDay =
  newestDaily.datetime.slice(0, 10) === todayUTC && d1.length >= 2
    ? d1[d1.length - 2]
    : newestDaily;

// EMA stack: +1 aligned up, -1 aligned down, 0 mixed/unknown.
let emaStack = 0;
if (ema20 !== null && ema50 !== null && ema200 !== null) {
  if (ema20 > ema50 && ema50 > ema200) emaStack = 1;
  else if (ema20 < ema50 && ema50 < ema200) emaStack = -1;
}

// Daily trend, independent of the 1h stack. Used for the conflict penalty.
const dailyCloses = d1.map((b) => b.close);
const dailyEma20 = ema(dailyCloses, 20);
let dailyTrend = 0;
if (dailyEma20 !== null) {
  if (price > dailyEma20 * 1.001) dailyTrend = 1;
  else if (price < dailyEma20 * 0.999) dailyTrend = -1;
}

// Compression: 8-bar 15m range relative to 1h ATR. < 0.6 is a squeeze.
// The bounds are exported too — range_squeeze publishes them as the levels to
// watch, since it has no directional bias of its own.
const range8High = highest(m15, 8, 'high');
const range8Low = lowest(m15, 8, 'low');
const range8 = range8High - range8Low;
const compressionRatio = range8 / atr1h;

// 24h change. 96 x 15m bars = 24h; fall back to prior-day close if short.
const idx24h = m15.length - 1 - 96;
const ref24h = idx24h >= 0 ? m15[idx24h].close : priorDay.close;
const change24hPct = ((price - ref24h) / ref24h) * 100;

// 1h swing structure over the last 20 bars.
const swingHigh = highest(h1, 20, 'high');
const swingLow = lowest(h1, 20, 'low');

// 5-day range position, 0 (at lows) .. 1 (at highs).
const hi5 = highest(d1, 5, 'high');
const lo5 = lowest(d1, 5, 'low');
const rangePos5d = hi5 > lo5 ? (price - lo5) / (hi5 - lo5) : 0.5;

// Dollar proxy. EUR/USD up means dollar down, which supports gold, so the
// sign of this slope maps directly onto a bullish-gold reading.
let dollarSlopePct = null;
let dollarDir = 0; // +1 supports gold longs, -1 supports shorts, 0 neutral
if (fx && fx.length >= 5) {
  const a = fx[fx.length - 5].close;
  const b = fx[fx.length - 1].close;
  dollarSlopePct = ((b - a) / a) * 100;
  if (dollarSlopePct > 0.05) dollarDir = 1;
  else if (dollarSlopePct < -0.05) dollarDir = -1;
}

// Session, and the range of the current session so far.
const nowUTC = new Date(nowMs);
const hourUTC = nowUTC.getUTCHours();
const session = sessionForHour(hourUTC);

const sessionStartHour = { asia: 0, london: 7, ny_overlap: 13, ny_afternoon: 17, late: 21 }[session];
const sessionStartMs = Date.UTC(
  nowUTC.getUTCFullYear(),
  nowUTC.getUTCMonth(),
  nowUTC.getUTCDate(),
  sessionStartHour,
);
const sessionBars = m15.filter((b) => b.t >= sessionStartMs);
const sessionHigh = sessionBars.length ? Math.max(...sessionBars.map((b) => b.high)) : null;
const sessionLow = sessionBars.length ? Math.min(...sessionBars.map((b) => b.low)) : null;

// First-hour range of the current session (4 x 15m bars from session open).
const firstHourBars = m15.filter(
  (b) => b.t >= sessionStartMs && b.t < sessionStartMs + 60 * 60 * 1000,
);
const firstHourHigh = firstHourBars.length >= 2 ? Math.max(...firstHourBars.map((b) => b.high)) : null;
const firstHourLow = firstHourBars.length >= 2 ? Math.min(...firstHourBars.map((b) => b.low)) : null;

// Last two closed 15m bars — used for break-and-hold confirmation.
const prev15 = m15.length >= 2 ? m15[m15.length - 2] : null;

return [
  {
    json: {
      // identity / display
      symbol: SYM,
      label: assetCfg.label,
      emoji: assetCfg.emoji,
      lang: assetCfg.lang || 'ru',
      tsUtc: new Date(nowMs).toISOString(),
      barAgeMin: round(barAgeMin, 1),

      // price
      price: round(price, 2),
      change24hPct: round(change24hPct, 2),

      // 1h trend
      ema20: round(ema20, 2),
      ema50: round(ema50, 2),
      ema200: round(ema200, 2),
      emaStack,
      dailyTrend,

      // volatility
      atr1h: round(atr1h, 2),
      atrDaily: round(atrDaily, 2),
      atrPctOfPrice: round((atr1h / price) * 100, 3),

      // structure
      priorDayHigh: round(priorDay.high, 2),
      priorDayLow: round(priorDay.low, 2),
      priorDayClose: round(priorDay.close, 2),
      priorDayDate: priorDay.datetime.slice(0, 10),
      swingHigh: round(swingHigh, 2),
      swingLow: round(swingLow, 2),
      rangePos5d: round(rangePos5d, 3),

      // compression
      range8: round(range8, 2),
      range8High: round(range8High, 2),
      range8Low: round(range8Low, 2),
      compressionRatio: round(compressionRatio, 3),

      // session
      session,
      hourUTC,
      sessionStartHour,
      sessionHigh: round(sessionHigh, 2),
      sessionLow: round(sessionLow, 2),
      firstHourHigh: round(firstHourHigh, 2),
      firstHourLow: round(firstHourLow, 2),

      // intermarket
      dollarSlopePct: round(dollarSlopePct, 3),
      dollarDir,

      // raw bars the scorer needs for break/sweep detection
      last15: {
        open: round(newest15.open, 2),
        high: round(newest15.high, 2),
        low: round(newest15.low, 2),
        close: round(newest15.close, 2),
        datetime: newest15.datetime,
      },
      prev15: prev15
        ? {
            open: round(prev15.open, 2),
            high: round(prev15.high, 2),
            low: round(prev15.low, 2),
            close: round(prev15.close, 2),
            datetime: prev15.datetime,
          }
        : null,
    },
    pairedItem: { item: 0 },
  },
];
