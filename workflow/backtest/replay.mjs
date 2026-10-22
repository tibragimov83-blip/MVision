/* ============================================================================
 * BACKTEST 2/2 — replay
 * ----------------------------------------------------------------------------
 *   node workflow/backtest/replay.mjs            # run the backtest
 *   node workflow/backtest/replay.mjs --selfcheck # test the outcome classifier
 *   node workflow/backtest/replay.mjs --hold 96   # 96 × 15min elapsed (default = 24h)
 *
 * Steps every 30 minutes across the cached history. At each decision time T it
 * builds "as-of-T" Twelve Data responses (only bars CLOSED by T — no
 * look-ahead), runs the REAL 02-indicators and 04-scorer node sources, and if a
 * directional signal fires, walks the 15min bars in [T,T+24h) to see whether target
 * or stop was hit first. Aggregates win-rate and expectancy per generator.
 *
 * It runs the exact code that posts to the channel — same files, same harness
 * as selfcheck.mjs. If a weight changes, the numbers here change with it.
 *
 * ponytail: the event gate is neutralised (no historical ForexFactory calendar
 * exists to replay), so the eventWithin60/120 penalties are NOT exercised here.
 * Everything else — every generator, every other weight, the level maths — is.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(HERE, '..', 'code');
const DATA = path.join(HERE, 'data');

// ------------------------------------------------------------- n8n harness ---
// Mirrors workflow/test/selfcheck.mjs — kept self-contained so the passing
// 80-check suite is never touched by backtest changes.

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

async function runNode(file, { input, nodes = {}, staticData, nowMs }) {
  const src = fs.readFileSync(path.join(CODE, file), 'utf8');
  const $input = { all: () => input, first: () => input[0] };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no stub for node "${name}"`);
    const items = nodes[name];
    return { all: () => items, first: () => items[0] };
  };
  const $getWorkflowStaticData = () => staticData;
  const body = `return (async () => {\n${src}\n})();`;
  const fn = new Function('$input', '$', '$getWorkflowStaticData', 'console', 'Date', body);
  return fn.call({}, $input, $, $getWorkflowStaticData, { log: () => {} }, fakeDate(nowMs));
}

// -------------------------------------------------------------- data model ---

function parseBarTime(dt) {
  const iso = dt.length <= 10 ? `${dt}T00:00:00Z` : `${dt.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

// The fetch plan's outputsize per series — what the live API hands back.
const OUTPUTSIZE = { '15min': 100, '1h': 200, '1day': 60, 'EUR': 20 };

function loadSeries() {
  if (!fs.existsSync(DATA)) {
    console.error('No cache. Run: TWELVEDATA_KEY=xxx node workflow/backtest/fetch-history.mjs');
    process.exit(1);
  }
  const read = (name) => {
    const p = path.join(DATA, `${name}.json`);
    if (!fs.existsSync(p)) {
      console.error(`Missing ${name}.json — run fetch-history.mjs first.`);
      process.exit(1);
    }
    const body = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Attach parsed open-time, keep everything else verbatim (string OHLC etc).
    const withT = closedCacheValues(body, IV[body.meta.interval])
      .map((v) => ({ ...v, _t: parseBarTime(v.datetime) }));
    withT.sort((a, b) => b._t - a._t); // newest-first, as the API delivers
    return { meta: body.meta, values: withT };
  };
  return {
    g15: read('XAUUSD_15min'),
    g1h: read('XAUUSD_1h'),
    g1d: read('XAUUSD_1day'),
    fx1h: read('EURUSD_1h'),
  };
}

/** Response containing only bars closed by T (open+interval <= T), newest N. */
function asOf(series, intervalMs, T, size) {
  const closed = series.values.filter((v) => v._t + intervalMs <= T);
  const newest = closed.slice(0, size); // already newest-first
  return {
    status: 'ok',
    meta: series.meta,
    values: newest.map(({ _t, ...v }) => v), // drop helper field
  };
}

const MIN = 60000;
const IV = { '15min': 15 * MIN, '1h': 60 * MIN, '1day': 24 * 60 * MIN };

// A frozen forming tail never becomes a closed historical candle just because
// replay runs later. Legacy caches lack capture metadata, so drop their newest
// candle conservatively; refetch to certify it instead of trusting file mtime.
export function closedCacheValues(body, intervalMs) {
  const captured = Date.parse(body._mvisionFetchedAt);
  const newestOpen = Math.max(...body.values.map(v => parseBarTime(v.datetime)));
  const cutoff = Number.isFinite(captured) ? Math.min(captured, Date.now()) : newestOpen;
  return body.values.filter(v => parseBarTime(v.datetime) + intervalMs <= cutoff);
}

// Clear gate: a real event far away, no penalty, no unknown-data penalty.
const GATE_CLEAR = {
  minutesToNext: 5000,
  nextEventTitle: 'Core CPI m/m',
  nextEventTsUtc: null,
  nextEventHuman: '3d',
  minutesSinceLast: 5000,
  lastEventTitle: 'ISM Manufacturing PMI',
  inPostEventWindow: false,
  eventDataUnknown: false,
  calendarStale: false,
  calendarSource: 'backtest',
  eventCount: 0,
};

// ------------------------------------------------------- outcome classifier ---

// Reuse the tracker's pure functions; deployed n8n code stays self-contained.
const trackerSource = fs.readFileSync(path.join(CODE, 'tracker-02-classify.js'), 'utf8')
  .split('// --- n8n input')[0];
const { classify, classifyObservation } = new Function(`${trackerSource}\nreturn { classify, classifyObservation };`)();

/** Timed bars use elapsed windows; untimed bars support the small walk selfcheck. */
export function classifyOutcome(direction, stop, target, bars, startMs, holdMs = 24 * 60 * 60 * 1000) {
  const outcome = Number.isFinite(startMs)
    ? classifyObservation(direction, stop, target, bars, startMs, startMs + holdMs)
    : classify(direction, stop, target, bars);
  return { target: 'win', stop: 'loss', none: 'timeout' }[outcome] ?? outcome;
}

// ------------------------------------------------------------- aggregation ---

function newAgg() {
  return { n: 0, win: 0, loss: 0, timeout: 0, rSum: 0 };
}
function record(agg, key, outcome, rr) {
  const a = (agg[key] = agg[key] || newAgg());
  a.n++;
  a[outcome]++;
  if (outcome === 'win') a.rSum += rr;
  else if (outcome === 'loss') a.rSum -= 1;
}
function fmtRow(label, a) {
  const decided = a.win + a.loss;
  const wr = decided ? ((a.win / decided) * 100).toFixed(0) + '%' : '—';
  const avgR = a.n ? (a.rSum / a.n).toFixed(2) : '—';
  return (
    label.padEnd(26) +
    String(a.n).padStart(5) +
    String(a.win).padStart(6) +
    String(a.loss).padStart(6) +
    String(a.timeout).padStart(8) +
    wr.padStart(7) +
    avgR.padStart(8)
  );
}

// ------------------------------------------------------------------ replay ---

async function replay(maxHold) {
  const holdMs = maxHold * IV['15min'];
  const { g15, g1h, g1d, fx1h } = loadSeries();

  // Oldest-first 15min bars drive both the step cadence and the outcome walk.
  const bars15 = g15.values.slice().sort((a, b) => a._t - b._t);
  const numeric15 = bars15.map((v) => ({
    t: v._t,
    high: parseFloat(v.high),
    low: parseFloat(v.low),
  }));

  const buildPlan = () => [
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '15min', outputsize: OUTPUTSIZE['15min'], label: 'GOLD', emoji: '🟡', lang: 'en' } },
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '1h', outputsize: OUTPUTSIZE['1h'], label: 'GOLD', emoji: '🟡', lang: 'en' } },
    { json: { role: 'asset', symbol: 'XAU/USD', interval: '1day', outputsize: OUTPUTSIZE['1day'], label: 'GOLD', emoji: '🟡', lang: 'en' } },
    { json: { role: 'dollar_proxy', symbol: 'EUR/USD', interval: '1h', outputsize: OUTPUTSIZE['EUR'], label: null, emoji: null, lang: 'en' } },
  ];

  const byGen = {};       // generator id
  const byGenBand = {};   // id|conviction
  const byScore = {};     // raw-score decile — the calibration that drives band thresholds
  const byBand = {};      // conviction band — the payoff of the banding rules
  const overall = newAgg();
  const newOnly = newAgg();

  let steps = 0, signals = 0, skipped = 0, errors = 0, pending = 0, ambiguous = 0, noData = 0;
  let prevKey = null;

  // Start once 100 15min bars exist behind us; step every 2 bars ≈ 30 min.
  const START = 100;
  for (let i = START; i < bars15.length; i += 2) {
    const T = numeric15[i].t + IV['15min']; // decision at this bar's close
    steps++;

    const responses = [
      { json: asOf(g15, IV['15min'], T, OUTPUTSIZE['15min']) },
      { json: asOf(g1h, IV['1h'], T, OUTPUTSIZE['1h']) },
      { json: asOf(g1d, IV['1day'], T, OUTPUTSIZE['1day']) },
      { json: asOf(fx1h, IV['1h'], T, OUTPUTSIZE['EUR']) },
    ];

    let indOut;
    try {
      indOut = await runNode('02-indicators.js', {
        input: responses,
        nodes: { 'Build fetch plan': buildPlan() },
        staticData: {},
        nowMs: T,
      });
    } catch (e) {
      errors++;
      continue;
    }
    if (!indOut || indOut.length === 0) { skipped++; continue; }

    const withGate = [{ json: { ...indOut[0].json, eventGate: GATE_CLEAR } }];
    let scoreOut;
    try {
      scoreOut = await runNode('04-scorer.js', {
        input: withGate, nodes: {}, staticData: {}, nowMs: T,
      });
    } catch (e) {
      errors++;
      continue;
    }

    const sig = scoreOut[0].json.signal;
    if (!sig || sig.direction === 'none' || sig.stop === null || sig.target === null) continue;

    // Timestamp bounds preserve elapsed hours across weekends and closures.
    const outcome = classifyOutcome(sig.direction, sig.stop, sig.target, numeric15, T, holdMs);
    if (outcome === 'pending') { pending++; continue; }
    if (outcome === 'ambiguous') { ambiguous++; continue; }
    if (outcome === 'no_data') { noData++; continue; }

    signals++;
    const key = `${sig.id}|${sig.direction}`;
    const isNew = key !== prevKey;
    prevKey = key;

    record(byGen, sig.id, outcome, sig.rr);
    record(byGenBand, `${sig.id}|${sig.conviction}`, outcome, sig.rr);
    record(byScore, String(Math.floor(sig.score / 10) * 10), outcome, sig.rr);
    record(byBand, sig.conviction, outcome, sig.rr);
    record({ o: overall }, 'o', outcome, sig.rr);
    if (isNew) record({ o: newOnly }, 'o', outcome, sig.rr);
  }

  // ---------------------------------------------------------------- report ---
  const first = new Date(numeric15[START].t).toISOString().slice(0, 10);
  const last = new Date(numeric15[numeric15.length - 1].t).toISOString().slice(0, 10);

  console.log(`\nBacktest XAU/USD  ${first} → ${last}  (maxHold ${maxHold / 4} elapsed hours)`);
  console.log(`steps ${steps} · signals ${signals} · market-closed skips ${skipped} · errors ${errors}\n`);
  console.log(`Unscored observations: pending ${pending} · ambiguous ${ambiguous} · no_data ${noData}\n`);

  const head = 'setup'.padEnd(26) + 'n'.padStart(5) + 'win'.padStart(6) + 'loss'.padStart(6) +
    'timeout'.padStart(8) + 'win%'.padStart(7) + 'avgR'.padStart(8);
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const id of Object.keys(byGen).sort()) console.log(fmtRow(id, byGen[id]));
  console.log('-'.repeat(head.length));
  console.log(fmtRow('ALL firings', overall));
  console.log(fmtRow('NEW setups only', newOnly));

  console.log('\nBy generator × conviction:');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const k of Object.keys(byGenBand).sort()) console.log(fmtRow(k, byGenBand[k]));

  // Score calibration: is a higher raw score actually a better outcome? If avgR
  // does not rise with the score bucket, the problem is the WEIGHTS, not the
  // band thresholds — moving 70/50/30 cannot fix a non-monotonic score.
  console.log('\nScore calibration (current bands: LOW≥30 MED≥50 HIGH≥70):');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const k of Object.keys(byScore).sort((a, b) => Number(a) - Number(b))) {
    console.log(fmtRow(`score ${k}-${Number(k) + 9}`, byScore[k]));
  }

  console.log('\nBy conviction band (what the subscriber sees):');
  console.log(head);
  console.log('-'.repeat(head.length));
  const bandOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, NO_EDGE: 3 };
  for (const k of Object.keys(byBand).sort((a, b) => (bandOrder[a] ?? 9) - (bandOrder[b] ?? 9))) {
    console.log(fmtRow(k, byBand[k]));
  }

  console.log('\nwin% = win/(win+loss), timeouts excluded from the rate.');
  console.log('avgR = mean realised R over ALL firings (win=+rr, loss=-1, timeout=0).');
  console.log('Event penalties are NOT modelled (no historical calendar). See header.');
}

// --------------------------------------------------------------- selfcheck ---

function selfcheck() {
  const bar = (h, l) => ({ high: h, low: l });
  let ok = 0;
  const T = (name, cond) => { if (cond) ok++; else { console.error('FAIL', name); process.exitCode = 1; } };

  // long: entry 100, stop 99, target 102
  T('long win',  classifyOutcome('long', 99, 102, [bar(101, 100), bar(102.5, 101)]) === 'win');
  T('long loss', classifyOutcome('long', 99, 102, [bar(100.5, 100), bar(100, 98.9)]) === 'loss');
  T('long timeout', classifyOutcome('long', 99, 102, [bar(101, 100), bar(101.5, 100.5)]) === 'timeout');
  T('long ambiguous->loss', classifyOutcome('long', 99, 102, [bar(102.5, 98.5)]) === 'loss');

  // short: entry 100, stop 101, target 98
  T('short win',  classifyOutcome('short', 101, 98, [bar(100.5, 99), bar(99, 97.5)]) === 'win');
  T('short loss', classifyOutcome('short', 101, 98, [bar(101.5, 100)]) === 'loss');
  T('short timeout', classifyOutcome('short', 101, 98, [bar(100, 99), bar(99.5, 98.5)]) === 'timeout');

  console.log(process.exitCode ? 'selfcheck FAILED' : `selfcheck OK (${ok} checks)`);
}

// ------------------------------------------------------------------- main ---

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes('--selfcheck')) {
    selfcheck();
  } else {
    const hi = args.indexOf('--hold');
    const maxHold = hi >= 0 ? Number(args[hi + 1]) : 96;
    if (!Number.isInteger(maxHold) || maxHold <= 0) throw new Error('--hold must be a positive number of 15-minute intervals');
    replay(maxHold).catch((e) => { console.error(e); process.exit(1); });
  }
}
