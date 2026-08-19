/* ============================================================================
 * SELF-CHECK — runs the real Code node sources outside n8n
 * ----------------------------------------------------------------------------
 *   node workflow/test/selfcheck.mjs
 *
 * No framework, no dependencies. It loads 02/04/05 verbatim, injects fake n8n
 * globals, feeds synthetic candles through them, and asserts the invariants
 * that actually matter — above all: every directional message carries a stop,
 * and that stop always sits inside the 0.30%–0.80% band.
 *
 * Node 03 (event gate) is not executed here because it makes a network call.
 * Its OUTPUT shape is injected directly instead, in both the normal and the
 * calendar-unavailable case.
 *
 * If you change a scoring weight or a generator, run this first.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(HERE, '..', 'code');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------- n8n harness ---

/** Date with a controllable "now", keeping parse/UTC intact. */
function fakeDate(nowMs) {
  return class extends Date {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() {
      return nowMs;
    }
  };
}

/**
 * Runs a Code node source file with injected globals.
 * The files use top-level `return`, which is legal inside a function body.
 */
async function runNode(file, { input, nodes = {}, staticData, nowMs, quiet = true }) {
  const src = fs.readFileSync(path.join(CODE, file), 'utf8');

  const $input = {
    all: () => input,
    first: () => input[0],
  };

  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Test harness: no stub for node "${name}"`);
    const items = nodes[name];
    return { all: () => items, first: () => items[0] };
  };

  const $getWorkflowStaticData = () => staticData;
  const fakeConsole = quiet ? { log: () => {} } : console;

  const body = `return (async () => {\n${src}\n})();`;
  const fn = new Function(
    '$input',
    '$',
    '$getWorkflowStaticData',
    'console',
    'Date',
    body,
  );

  return fn.call({}, $input, $, $getWorkflowStaticData, fakeConsole, fakeDate(nowMs));
}

// ------------------------------------------------------------- fixtures -----

const MS = { '15min': 900000, '1h': 3600000, '1day': 86400000 };

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms, interval) {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (interval === '1day') return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

/**
 * Deterministic synthetic series, newest-first, string fields — matching the
 * Twelve Data contract exactly (including its quirks).
 */
function makeSeries({
  symbol,
  interval,
  count,
  endMs,
  startPrice,
  driftPerBar = 0,
  rangePerBar = 4,
  tailOverrides = {},
}) {
  const step = MS[interval];
  const bars = [];
  for (let i = 0; i < count; i++) {
    const t = endMs - (count - 1 - i) * step;
    const mid = startPrice + driftPerBar * i;
    // Deterministic wobble so ATR is non-zero but reproducible.
    const wob = ((i % 5) - 2) * (rangePerBar / 8);
    const open = mid + wob;
    const close = mid + wob + driftPerBar * 0.5;
    const high = Math.max(open, close) + rangePerBar / 2;
    const low = Math.min(open, close) - rangePerBar / 2;
    bars.push({ t, open, high, low, close });
  }

  // Overrides addressed from the end: {0: lastBar, 1: secondToLast, ...}
  for (const [k, ov] of Object.entries(tailOverrides)) {
    const idx = bars.length - 1 - Number(k);
    if (idx >= 0) Object.assign(bars[idx], ov);
  }

  return {
    status: 'ok',
    meta: { symbol, interval },
    values: bars
      .slice()
      .reverse() // Twelve Data is newest-first
      .map((b) => ({
        datetime: stamp(b.t, interval),
        // 5dp, NOT 2dp. Formatting FX to 2 decimals collapses EUR/USD 1.0850
        // to "1.09" for every bar, which silently zeroes the dollar slope and
        // made the dollarAgrees weight untestable.
        open: b.open.toFixed(5),
        high: b.high.toFixed(5),
        low: b.low.toFixed(5),
        close: b.close.toFixed(5),
      })),
  };
}

/**
 * The fetch plan as node 01 emits it, for a given language.
 * Text assertions below pin lang:'en' so they stay readable; a dedicated
 * Russian case checks the localisation itself.
 */
const makePlan = (lang = 'en') => {
  const label = lang === 'ru' ? 'ЗОЛОТО' : 'GOLD';
  return [
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '15min', outputsize: 100, label, emoji: '\u{1F7E1}', lang } },
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '1h', outputsize: 200, label, emoji: '\u{1F7E1}', lang } },
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '1day', outputsize: 60, label, emoji: '\u{1F7E1}', lang } },
    { json: { role: 'dollar_proxy', symbol: 'EUR/USD', interval: '1h', outputsize: 20, label: null, emoji: null, lang } },
  ];
};

const PLAN = makePlan('en');

/** A Wednesday 14:10 UTC (NY overlap), so breakout signals get session fit. */
const NOW = Date.UTC(2026, 7, 19, 14, 10, 0);
const LAST_15_CLOSE_MS = Date.UTC(2026, 7, 19, 14, 0, 0); // 10 min old, fresh

/**
 * All series are built to END at `basePrice`, so the 15m, 1h and daily views
 * agree with each other. The first version of this fixture let the 1h series
 * sit at 2500 while the 15m sat at 2412, which produced a nonsense 3.8% target
 * and hid a real defect behind a broken fixture.
 *
 * `dollarTrend` is separate from `trend` so the dollarAgrees weight can be
 * driven independently of price action.
 */
function buildResponses({
  trend = 'up',
  compress = false,
  breakPriorDay = true,
  breakPriorDayLow = false,
  basePrice = 2412,
  dollarTrend = null,
} = {}) {
  const drift15 = trend === 'up' ? 0.12 : trend === 'down' ? -0.12 : 0;
  const drift1h = trend === 'up' ? 0.5 : trend === 'down' ? -0.5 : 0;
  const fxDrift = (dollarTrend ?? trend) === 'up' ? 0.0004 : (dollarTrend ?? trend) === 'down' ? -0.0004 : 0;

  // Prior day: high 2400, low 2372. A close outside either is a clean break.
  const daily = makeSeries({
    symbol: 'XAU/USD',
    interval: '1day',
    count: 60,
    endMs: Date.UTC(2026, 7, 19),
    startPrice: basePrice - 60,
    driftPerBar: 1.0,
    rangePerBar: 18,
    tailOverrides: {
      1: { high: 2400, low: 2372, close: 2396 },                       // prior day
      0: { high: basePrice + 4, low: basePrice - 18, close: basePrice }, // today, forming
    },
  });

  let tail = {};
  if (breakPriorDay) {
    // Two consecutive closes above 2400 = break and hold.
    tail = {
      1: { open: 2406, high: 2412, low: 2405, close: 2410 },
      0: { open: 2410, high: 2415, low: 2409, close: basePrice },
    };
  } else if (breakPriorDayLow) {
    // Mirror: two consecutive closes below 2372.
    tail = {
      1: { open: 2374, high: 2375, low: 2368, close: 2370 },
      0: { open: 2370, high: 2371, low: 2364, close: basePrice },
    };
  }

  const m15count = 100;
  const m15 = makeSeries({
    symbol: 'XAU/USD',
    interval: '15min',
    count: m15count,
    endMs: LAST_15_CLOSE_MS,
    startPrice: basePrice - (compress ? 0 : drift15 * (m15count - 1)),
    driftPerBar: compress ? 0 : drift15,
    rangePerBar: compress ? 0.4 : 5,
    tailOverrides: tail,
  });

  const h1count = 200;
  const h1 = makeSeries({
    symbol: 'XAU/USD',
    interval: '1h',
    count: h1count,
    endMs: LAST_15_CLOSE_MS,
    startPrice: basePrice - drift1h * (h1count - 1), // ends at basePrice
    driftPerBar: drift1h,
    rangePerBar: compress ? 2 : 6,
  });

  const fx = makeSeries({
    symbol: 'EUR/USD',
    interval: '1h',
    count: 20,
    endMs: LAST_15_CLOSE_MS,
    startPrice: 1.085,
    driftPerBar: fxDrift,
    rangePerBar: 0.0008,
  });

  return [m15, h1, daily, fx].map((r) => ({ json: r }));
}

const GATE_CLEAR = {
  minutesToNext: 1140,
  nextEventTitle: 'Core CPI m/m',
  nextEventTsUtc: '2026-08-20T12:30:00.000Z',
  nextEventHuman: '19h',
  minutesSinceLast: 4000,
  lastEventTitle: 'ISM Manufacturing PMI',
  inPostEventWindow: false,
  eventDataUnknown: false,
  calendarStale: false,
  calendarSource: 'cache',
  eventCount: 6,
};

const GATE_IMMINENT = { ...GATE_CLEAR, minutesToNext: 34, nextEventHuman: '34 min' };

const GATE_UNKNOWN = {
  minutesToNext: null,
  nextEventTitle: null,
  nextEventTsUtc: null,
  nextEventHuman: null,
  minutesSinceLast: null,
  lastEventTitle: null,
  inPostEventWindow: false,
  eventDataUnknown: true,
  calendarStale: false,
  calendarSource: 'unavailable',
  eventCount: 0,
};

/**
 * A complete indicator context with neutral defaults — every generator is OFF.
 * Override only the fields a test needs, so exactly one candidate can fire.
 * This is how the directionless-cap rule gets tested deterministically, instead
 * of hoping a synthetic candle series happens to isolate it.
 */
function neutralContext(overrides = {}) {
  const price = 2390;
  return {
    symbol: 'XAU/USD',
    label: 'GOLD',
    emoji: '\u{1F7E1}',
    lang: 'en',
    tsUtc: new Date(NOW).toISOString(),
    barAgeMin: 10,
    price,
    change24hPct: 0.01,
    ema20: price,        // price sits ON the EMA -> no mean_reversion
    ema50: price,
    ema200: price,
    emaStack: 0,         // -> no trend_continuation
    dailyTrend: 0,
    atr1h: 6,
    atrDaily: 20,
    atrPctOfPrice: 0.251,
    priorDayHigh: 2400,  // price inside the range -> no break
    priorDayLow: 2372,
    priorDayClose: 2396,
    priorDayDate: '2026-08-18',
    swingHigh: 2405,
    swingLow: 2378,
    rangePos5d: 0.5,
    range8: 2.4,
    range8High: 2391,
    range8Low: 2388.6,
    compressionRatio: 0.9, // -> no range_squeeze unless overridden
    session: 'asia',
    hourUTC: 3,
    sessionStartHour: 0,
    sessionHigh: 2392,
    sessionLow: 2388,
    firstHourHigh: null,   // -> no session_open_break
    firstHourLow: null,
    dollarSlopePct: 0,
    dollarDir: 0,
    last15: { open: 2390, high: 2391, low: 2389, close: price, datetime: '2026-08-19 14:00:00' },
    prev15: { open: 2389, high: 2390.5, low: 2388.5, close: 2389.8, datetime: '2026-08-19 13:45:00' },
    eventGate: GATE_CLEAR,
    ...overrides,
  };
}

/** Runs only the scorer against a hand-built context. */
async function runScorerDirect(overrides = {}, sd = {}) {
  const out = await runNode('04-scorer.js', {
    input: [{ json: neutralContext(overrides) }],
    nodes: {},
    staticData: sd,
    nowMs: NOW,
  });
  return out[0].json;
}

// --------------------------------------------------------------- pipeline ---

async function pipeline({ scenario = {}, gate = GATE_CLEAR, llmText = null, sd = {}, lang = 'en' } = {}) {
  const responses = buildResponses(scenario);

  const indOut = await runNode('02-indicators.js', {
    input: responses,
    nodes: { 'Build fetch plan': makePlan(lang) },
    staticData: sd,
    nowMs: NOW,
  });

  if (indOut.length === 0) return { skipped: true, indicators: null, signal: null, formatted: null };

  const withGate = [{ json: { ...indOut[0].json, eventGate: gate } }];

  const scoreOut = await runNode('04-scorer.js', {
    input: withGate,
    nodes: {},
    staticData: sd,
    nowMs: NOW,
  });

  const scorerItem = scoreOut[0];
  const llmItem = [{ json: { text: llmText === null ? scorerItem.json.signal.note : llmText } }];

  const fmtOut = await runNode('05-format.js', {
    input: llmItem,
    nodes: { Scorer: [scorerItem] },
    staticData: sd,
    nowMs: NOW,
  });

  return {
    skipped: false,
    indicators: indOut[0].json,
    signal: scorerItem.json,
    formatted: fmtOut[0].json,
  };
}

// ------------------------------------------------------------------ tests ---

const VERBOSE = process.argv.includes('--verbose');

function dump(title, r) {
  if (!VERBOSE) return;
  console.log(`\n${'─'.repeat(70)}\n${title}`);
  if (r.skipped) {
    console.log('  (run skipped — stale data)');
    return;
  }
  const s = r.signal.signal;
  console.log(
    `  winner=${s.id} dir=${s.direction} score=${s.score} band=${s.conviction} ` +
      `entry=${s.entry} stop=${s.stop} target=${s.target} rr=${s.rr} stopPct=${s.stopPct}%`,
  );
  console.log(`  components=${JSON.stringify(s.components)}`);
  console.log(`  candidates=${JSON.stringify(r.signal.allCandidates)}`);
  console.log(`  prose=${r.formatted._proseSource}  notified=${r.formatted.notified}`);
  console.log(`  atrPct=${r.indicators.atrPctOfPrice}% emaStack=${r.indicators.emaStack} dollarDir=${r.indicators.dollarDir} session=${r.indicators.session}`);
  console.log(`\n${r.formatted.messageHtml}\n`);
}

console.log('Running self-check…\n');

// --- 1. Uptrend breaking prior-day high -------------------------------------
{
  const r = await pipeline({ scenario: { trend: 'up', breakPriorDay: true } });
  dump('SCENARIO 1 — uptrend breaking prior-day high, clear calendar', r);
  const sig = r.signal.signal;

  check('1a. run not skipped on fresh data', !r.skipped);
  check('1b. indicators produced a positive ATR', r.indicators.atr1h > 0, `atr1h=${r.indicators?.atr1h}`);
  check('1c. prior-day high read from the completed bar, not today', r.indicators.priorDayHigh === 2400, `got ${r.indicators?.priorDayHigh}`);
  check('1d. a candidate fired', r.signal.candidateCount > 0);
  check('1e. break signal won', sig.id === 'pdh_pdl_break', `winner was ${sig.id}`);
  check('1f. direction is long', sig.direction === 'long', `got ${sig.direction}`);
  check('1g. stop is below entry for a long', sig.stop < sig.entry, `entry=${sig.entry} stop=${sig.stop}`);
  check('1h. target is above entry for a long', sig.target > sig.entry, `entry=${sig.entry} target=${sig.target}`);

  const stopPct = (Math.abs(sig.entry - sig.stop) / sig.entry) * 100;
  check(
    '1i. stop distance inside the 0.30–0.80% band',
    stopPct >= 0.2995 && stopPct <= 0.8005,
    `${stopPct.toFixed(3)}%`,
  );

  const expectedRR = Math.abs(sig.target - sig.entry) / Math.abs(sig.entry - sig.stop);
  check('1j. R:R matches the levels', Math.abs(sig.rr - expectedRR) < 0.02, `rr=${sig.rr} expected≈${expectedRR.toFixed(2)}`);
  check('1k. message includes a Stop line', r.formatted.messageHtml.includes('Stop'), 'directional message must carry an invalidation level');
  check('1l. message under Telegram cap', r.formatted.messageHtml.length < 4096, `${r.formatted.messageHtml.length} chars`);
}

// --- 2. Directionless signal is capped at LOW (isolated, deterministic) -----
{
  // compressionRatio 0.35 fires range_squeeze; every other generator is off by
  // construction, so the winner is guaranteed to be the directionless one.
  const s = await runScorerDirect({ compressionRatio: 0.35 });
  const sig = s.signal;

  check('2a. only range_squeeze fired', s.candidateCount === 1 && sig.id === 'range_squeeze', `candidates: ${JSON.stringify(s.allCandidates)}`);
  check('2b. directionless signal is capped at LOW', sig.conviction === 'LOW', `got ${sig.conviction} at score ${sig.score}`);
  check('2c. directionless signal publishes no stop', sig.stop === null, `stop=${sig.stop}`);
  check('2d. directionless signal publishes no R:R', sig.rr === null, `rr=${sig.rr}`);
  check('2e. the range boundaries are carried for the message', sig.extras.rangeHigh === 2391 && sig.extras.rangeLow === 2388.6);

  // And through the formatter: no stop line, explicit "no call".
  const fmt = await runNode('05-format.js', {
    input: [{ json: { text: sig.note } }],
    nodes: { Scorer: [{ json: s }] },
    staticData: {},
    nowMs: NOW,
  });
  const msg = fmt[0].json.messageHtml;
  check('2f. message states no directional call', msg.includes('No directional call'));
  check('2g. message omits any Stop line', !msg.includes('Stop'), 'must not imply a stop it does not have');
  check('2h. LOW band suppresses the notification', fmt[0].json.notified === false);
}

// --- 2i. A directionless signal scoring high STILL cannot publish a call ----
{
  // Force the score up so the cap is the only thing holding it back.
  const s = await runScorerDirect({
    compressionRatio: 0.35,
    session: 'asia',        // compression's preferred session -> +8
    atrPctOfPrice: 0.05,    // compression's vol fit -> +10
  });
  check(
    '2i. high-scoring directionless signal is still capped at LOW',
    s.signal.direction !== 'none' || s.signal.conviction === 'LOW',
    `id=${s.signal.id} score=${s.signal.score} band=${s.signal.conviction}`,
  );
}

// --- 3. Imminent event crushes the score -----------------------------------
{
  const clear = await pipeline({ scenario: { trend: 'up', breakPriorDay: true }, gate: GATE_CLEAR });
  const risky = await pipeline({ scenario: { trend: 'up', breakPriorDay: true }, gate: GATE_IMMINENT });

  check(
    '3a. event within 60 min lowers the score',
    risky.signal.signal.score < clear.signal.signal.score,
    `clear=${clear.signal.signal.score} risky=${risky.signal.signal.score}`,
  );
  check(
    '3b. the -40 penalty was recorded',
    risky.signal.signal.components.eventWithin60 === -40 || risky.signal.signal.conviction === 'NO_EDGE',
    JSON.stringify(risky.signal.signal.components),
  );
  check('3c. imminent event is surfaced in the message', risky.formatted.messageHtml.includes('34 min'));
}

// --- 4. Unknown calendar is treated as risk, not safety --------------------
{
  const r = await pipeline({ scenario: { trend: 'up', breakPriorDay: true }, gate: GATE_UNKNOWN });
  check(
    '4a. missing calendar data applies a precautionary penalty',
    r.signal.signal.components.eventDataUnknown === -20,
    JSON.stringify(r.signal.signal.components),
  );
  check('4b. message discloses the calendar outage', r.formatted.messageHtml.includes('calendar unavailable'));
}

// --- 5. LLM guardrails ----------------------------------------------------
{
  const invented = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    llmText: 'Gold is pushing higher toward major resistance at 2987.50 with momentum building.',
  });
  check(
    '5a. invented price is rejected and the template used',
    invented.formatted._proseSource.startsWith('template'),
    invented.formatted._proseSource,
  );
  check('5b. the invented number never reaches the message', !invented.formatted.messageHtml.includes('2987'));

  const tooLong = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    llmText: 'x'.repeat(400),
  });
  check('5c. over-long prose is rejected', tooLong.formatted._proseSource.startsWith('template'));

  const legit = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    llmText: 'Price cleared yesterday high and is holding, with the dollar softening.',
  });
  check('5d. clean prose with no numbers is accepted', legit.formatted._proseSource === 'llm', legit.formatted._proseSource);

  const injection = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    llmText: 'Momentum is <b>strong</b> & building further.',
  });
  check(
    '5e. HTML in prose is escaped, not passed through',
    injection.formatted.messageHtml.includes('&lt;b&gt;') && injection.formatted.messageHtml.includes('&amp;'),
  );
}

// --- 6. Stale data ends the run silently ----------------------------------
{
  const sd = {};
  const staleResponses = buildResponses({ trend: 'up' }).map((item) => {
    // Shift every series back three hours so the newest 15m bar is stale.
    const shifted = {
      ...item.json,
      values: item.json.values.map((v) => {
        if (!v.datetime.includes(':')) return v; // daily bars keep their dates
        const ms = Date.parse(`${v.datetime.replace(' ', 'T')}Z`) - 3 * 3600000;
        return { ...v, datetime: stamp(ms, '15min') };
      }),
    };
    return { json: shifted };
  });

  const out = await runNode('02-indicators.js', {
    input: staleResponses,
    nodes: { 'Build fetch plan': PLAN },
    staticData: sd,
    nowMs: NOW,
  });

  check('6a. stale data returns no items (no post)', out.length === 0, `got ${out.length} items`);
  check('6b. the skip was counted', sd.skipped === 1, `skipped=${sd.skipped}`);
}

// --- 7. Twelve Data error surfaces as a thrown error ----------------------
{
  let threw = false;
  let msg = '';
  try {
    await runNode('02-indicators.js', {
      input: [{ json: { status: 'error', code: 429, message: 'You have run out of API credits' } }],
      nodes: { 'Build fetch plan': PLAN },
      staticData: {},
      nowMs: NOW,
    });
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  check('7a. an API error throws rather than posting garbage', threw);
  check('7b. the error message is preserved for the DM', msg.includes('API credits'), msg);
}

// --- 8. Repeat detection --------------------------------------------------
{
  const sd = {};
  const a = await pipeline({ scenario: { trend: 'up', breakPriorDay: true }, sd });
  const b = await pipeline({ scenario: { trend: 'up', breakPriorDay: true }, sd });

  check('8a. first sighting is consecutive=1', a.signal.consecutive === 1, `got ${a.signal.consecutive}`);
  check('8b. repeat increments the counter', b.signal.consecutive === 2, `got ${b.signal.consecutive}`);
  check('8c. repeat marker appears in the message', b.formatted.messageHtml.includes('consecutive'));
}

// --- 9. Notification policy ----------------------------------------------
{
  const r = await pipeline({ scenario: { trend: 'up', breakPriorDay: true } });
  const conv = r.signal.signal.conviction;
  const notified = r.formatted.notified;
  check(
    '9a. notification enabled only for HIGH/MEDIUM',
    notified === (conv === 'HIGH' || conv === 'MEDIUM'),
    `conviction=${conv} notified=${notified}`,
  );
  check('9b. disableNotification is the inverse of notified', r.formatted.disableNotification === !notified);
}

// --- 10. Sheets row shape ------------------------------------------------
{
  const r = await pipeline({ scenario: { trend: 'up', breakPriorDay: true } });
  const required = [
    'ts_utc', 'price', 'signal_id', 'direction', 'score', 'conviction',
    'entry', 'stop', 'target', 'rr', 'components', 'event_gate_min',
    'session', 'consecutive', 'notified', 'outcome_24h',
  ];
  const missing = required.filter((k) => !(k in r.formatted));
  check('10a. every log column is present', missing.length === 0, `missing: ${missing.join(', ')}`);
  check('10b. components is valid JSON', (() => { try { JSON.parse(r.formatted.components); return true; } catch { return false; } })());
  check('10c. outcome_24h is left empty for phase 1', r.formatted.outcome_24h === '');
}

// --- 11. Short side — the mirror logic, where sign bugs live ---------------
{
  const r = await pipeline({
    scenario: { trend: 'down', breakPriorDay: false, breakPriorDayLow: true, basePrice: 2366 },
  });
  dump('SCENARIO 11 — downtrend breaking prior-day low', r);
  const sig = r.signal.signal;

  check('11a. break signal won on the short side', sig.id === 'pdh_pdl_break', `winner=${sig.id}`);
  check('11b. direction is short', sig.direction === 'short', `got ${sig.direction}`);
  check('11c. stop is ABOVE entry for a short', sig.stop > sig.entry, `entry=${sig.entry} stop=${sig.stop}`);
  check('11d. target is BELOW entry for a short', sig.target < sig.entry, `entry=${sig.entry} target=${sig.target}`);

  const stopPct = (Math.abs(sig.entry - sig.stop) / sig.entry) * 100;
  check('11e. short stop also inside the 0.30–0.80% band', stopPct >= 0.2995 && stopPct <= 0.8005, `${stopPct.toFixed(3)}%`);

  const expectedRR = Math.abs(sig.target - sig.entry) / Math.abs(sig.entry - sig.stop);
  check('11f. short R:R matches the levels', Math.abs(sig.rr - expectedRR) < 0.02, `rr=${sig.rr} expected≈${expectedRR.toFixed(2)}`);
  check('11g. message says SHORT', r.formatted.messageHtml.includes('SHORT'));

  // Percentage signs must be relative to entry, so they invert on a short.
  const stopLine = r.formatted.messageHtml.split('\n').find((l) => l.includes('Stop'));
  const tgtLine = r.formatted.messageHtml.split('\n').find((l) => l.includes('Target'));
  check('11h. short stop shows a POSITIVE offset (it sits above entry)', /\(\+[\d.]+%\)/.test(stopLine), stopLine);
  check('11i. short target shows a NEGATIVE offset (it sits below entry)', /\(-[\d.]+%\)/.test(tgtLine), tgtLine);
}

// --- 11j. …and the long side keeps the opposite signs ----------------------
{
  const r = await pipeline({ scenario: { trend: 'up', breakPriorDay: true } });
  const stopLine = r.formatted.messageHtml.split('\n').find((l) => l.includes('Stop'));
  const tgtLine = r.formatted.messageHtml.split('\n').find((l) => l.includes('Target'));
  check('11j. long stop shows a NEGATIVE offset', /\(-[\d.]+%\)/.test(stopLine), stopLine);
  check('11k. long target shows a POSITIVE offset', /\(\+[\d.]+%\)/.test(tgtLine), tgtLine);
}

// --- 12. Target distance is bounded to an intraday horizon -----------------
{
  // swingHigh parked 6% away — a swing level, not an intraday target.
  // It must be rejected in favour of the 2R fallback.
  // price MUST equal last15.close — node 2 always produces them equal, so a
  // context where they disagree would test a state that cannot occur.
  const s = await runScorerDirect({
    emaStack: 1,
    dailyTrend: 1,
    price: 2405,
    ema20: 2388,
    last15: { open: 2401, high: 2406, low: 2400, close: 2405, datetime: '2026-08-19 14:00:00' },
    prev15: { open: 2400, high: 2403, low: 2399, close: 2402, datetime: '2026-08-19 13:45:00' },
    swingHigh: 2535,     // ~5.4% away — a swing level, not an intraday target
    sessionHigh: 2534,
    priorDayHigh: 2400,
  });
  const sig = s.signal;
  check('12a. a directional signal was produced', sig.direction === 'long', `dir=${sig.direction} id=${sig.id}`);
  check('12b0. the far swing level was NOT chosen as target', sig.target < 2450, `target=${sig.target}`);

  const distR = Math.abs(sig.target - sig.entry) / Math.abs(sig.entry - sig.stop);
  check('12b. target is not a swing-scale level', distR <= 4.01, `target sat at ${distR.toFixed(2)}R`);
  check('12c. R:R stays plausible for an intraday hold', sig.rr <= 4.01, `rr=${sig.rr}`);
}

// --- 13. Russian localisation ---------------------------------------------
{
  const r = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    lang: 'ru',
    llmText: 'Золото укрепляется выше вчерашнего максимума при слабеющем долларе.',
  });
  dump('SCENARIO 13 — Russian output', r);
  const msg = r.formatted.messageHtml;
  const sig = r.signal.signal;

  check('13a. asset label is localised', msg.includes('ЗОЛОТО'), msg.split('\n')[0]);
  check('13b. direction is localised', msg.includes('ЛОНГ'), 'expected ЛОНГ for a long');
  check('13c. level labels are localised', msg.includes('Вход') && msg.includes('Стоп') && msg.includes('Цель'));
  check('13d. no English labels leak through', !/\b(Entry|Stop|Target|conviction)\b/.test(msg), msg);
  check('13e. disclaimer is localised', msg.includes('Аналитический сигнал'), 'expected the Russian disclaimer');
  check('13e2. English disclaimer does not leak into a Russian message', !msg.includes('Analytical signal · you make'));
  const headerLine = msg.split('\n')[1];
  check('13f. session name is localised', /[А-Яа-яЁё]/.test(headerLine), headerLine);
  check(
    '13f2. no English session name leaks',
    !/(asia|london|ny overlap|ny afternoon|late) session|ny overlap/.test(msg),
    headerLine,
  );
  check('13g. scorer note is localised', /Пробой вчерашнего/.test(sig.note), sig.note);
  check('13h. langName is handed to the LLM prompt', r.signal.langName.includes('Russian'), r.signal.langName);
  check('13i. Russian prose passes validation', r.formatted._proseSource === 'llm', r.formatted._proseSource);

  // Numbers stay in en-US format in every language, so the whitelist is intact.
  check('13j. prices still render as 1,234.56', /\d,\d{3}\.\d{2}/.test(msg), msg);

  // Event names are localised in the chrome and never leak English.
  const eventLine = msg.split('\n').find((l) => l.includes('событие'));
  check('13l. event name is localised in the chrome', eventLine && eventLine.includes('базовый ИПЦ'), eventLine);
  check('13m. no English event title leaks', !msg.includes('Core CPI'), eventLine);
  check('13n. scorer exposes the localised event name', r.signal.eventNextLocal === 'базовый ИПЦ м/м', r.signal.eventNextLocal);
  check('13o. the LLM facts carry the localised event name', r.signal.llmFacts.includes('базовый ИПЦ'), 'facts must match chrome');

  // The block must be a single <pre> (fixed-width on all Telegram clients),
  // and its three lines must keep the number column aligned.
  check('13k. levels use a <pre> block, not stacked <code>', msg.includes('<pre>') && !msg.includes('<code>'), msg);
  const blockLines = msg
    .split('\n')
    .map((l) => l.replace('<pre>', '').replace('</pre>', ''))
    .filter((l) => /^(Вход|Стоп|Цель)/.test(l));
  const cols = blockLines.map((l) => l.search(/\d/));
  check('13k2. number column stays aligned', blockLines.length === 3 && new Set(cols).size === 1, `starts at ${cols.join(', ')}`);
}

// --- 14. A Russian comma decimal is rejected, not published ---------------
{
  // Russian convention would write 4357,91 — that must not reach the channel,
  // because the digit whitelist cannot verify it against the facts.
  const r = await pipeline({
    scenario: { trend: 'up', breakPriorDay: true },
    lang: 'ru',
    llmText: 'Золото торгуется на уровне 4357,91 с восходящим трендом.',
  });
  check(
    '14a. comma-decimal prose falls back to the template',
    r.formatted._proseSource.startsWith('template'),
    r.formatted._proseSource,
  );
  check('14b. the unverifiable number never reaches the message', !r.formatted.messageHtml.includes('4357,91'));
}

// --- 15. NO_EDGE must not show the repeat marker --------------------------
{
  const sd = {};
  await runScorerDirect({}, sd);             // NO_EDGE, consecutive 1
  const s2 = await runScorerDirect({}, sd);  // NO_EDGE again, consecutive 2
  check('15a. repeated NO_EDGE still increments the counter', s2.consecutive === 2, `got ${s2.consecutive}`);

  const fmt = await runNode('05-format.js', {
    input: [{ json: { text: s2.signal.note } }],
    nodes: { Scorer: [{ json: s2 }] },
    staticData: {},
    nowMs: NOW,
  });
  const msg = fmt[0].json.messageHtml;
  check('15b. NO_EDGE does not show the repeat marker', !/consecutive|подряд/.test(msg), msg);
}

// ----------------------------------------------------------------- report ---

console.log(`${passed} checks passed`);
if (failures.length > 0) {
  console.log(`${failures.length} FAILED:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
