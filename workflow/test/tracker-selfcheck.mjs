/* ============================================================================
 * TRACKER SELF-CHECK — runs the real tracker Code node sources outside n8n
 * ----------------------------------------------------------------------------
 *   node workflow/test/tracker-selfcheck.mjs
 *
 * Feeds a synthetic signals sheet + a synthetic 15min price series through
 * tracker-01-select.js and tracker-02-classify.js and asserts:
 *   - selection excludes scored / non-directional / too-recent rows
 *   - each outcome class is produced correctly: target, stop, none, no_data
 *
 * The price series rises monotonically, so outcomes are set purely by each
 * row's stop/target levels — deterministic and easy to reason about.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(HERE, '..', 'code');

let passed = 0;
const failures = [];
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`);

// --- n8n harness (mirrors selfcheck.mjs) ------------------------------------
function fakeDate(nowMs) {
  return class extends Date {
    constructor(...a) { a.length ? super(...a) : super(nowMs); }
    static now() { return nowMs; }
  };
}
async function runNode(file, { input, nodes = {}, nowMs }) {
  const src = fs.readFileSync(path.join(CODE, file), 'utf8');
  const $input = { all: () => input, first: () => input[0] };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no stub for node "${name}"`);
    return { all: () => nodes[name], first: () => nodes[name][0] };
  };
  const body = `return (async () => {\n${src}\n})();`;
  const fn = new Function('$input', '$', '$getWorkflowStaticData', 'console', 'Date', body);
  return fn.call({}, $input, $, () => ({}), { log: () => {} }, fakeDate(nowMs));
}

// --- synthetic world --------------------------------------------------------
const H = 3600000;
const NOW = Date.UTC(2026, 7, 27, 22, 30); // fixed "now"
const SERIES_START = NOW - 40 * H;          // 15min bars span the last 40h
const priceAt = (ms) => 2400 + (ms - SERIES_START) / H; // +1.00 per hour, rising

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
};

function buildSeries() {
  const bars = [];
  for (let t = SERIES_START; t <= NOW; t += 15 * 60000) {
    const close = priceAt(t);
    bars.push({ datetime: stamp(t), open: (close - 0.25).toFixed(2), high: (close + 0.5).toFixed(2), low: (close - 0.5).toFixed(2), close: close.toFixed(2) });
  }
  bars.reverse(); // Twelve Data is newest-first
  return { status: 'ok', meta: { symbol: 'XAU/USD', interval: '15min' }, values: bars };
}

const iso = (ms) => new Date(ms).toISOString();
const at = (h) => NOW - h * H;               // h hours ago
const entryAt = (h) => priceAt(at(h));

// Rows exercise every branch. entry = price at the signal time; levels relative.
const rows = [
  // excluded by Select:
  { ts_utc: iso(at(30)), direction: 'long', stop: entryAt(30) - 5, target: entryAt(30) + 10, outcome_24h: 'target' }, // already scored
  { ts_utc: iso(at(30)), direction: 'none', stop: '', target: '', outcome_24h: '' },                                  // NO_EDGE
  { ts_utc: iso(at(2)),  direction: 'long', stop: entryAt(2) - 5, target: entryAt(2) + 10, outcome_24h: '' },         // too recent
  // scored by Classify (rising price):
  { ts_utc: iso(at(30)), direction: 'long',  stop: entryAt(30) - 5,  target: entryAt(30) + 10, outcome_24h: '' },     // -> target
  { ts_utc: iso(at(28)), direction: 'short', stop: entryAt(28) + 5,  target: entryAt(28) - 10, outcome_24h: '' },     // -> stop
  { ts_utc: iso(at(27)), direction: 'long',  stop: entryAt(27) - 50, target: entryAt(27) + 50, outcome_24h: '' },     // -> none
  { ts_utc: iso(at(50)), direction: 'long',  stop: entryAt(50) - 5,  target: entryAt(50) + 10, outcome_24h: '' },     // -> no_data (before series)
];

async function main() {
  const selectOut = await runNode('tracker-01-select.js', {
    input: rows.map((json) => ({ json })),
    nowMs: NOW,
  });

  const pending = selectOut.length ? selectOut[0].json.pending : [];
  check('select excludes scored/noedge/recent', pending.length === 4, `got ${pending.length}`);

  const classifyOut = await runNode('tracker-02-classify.js', {
    input: [{ json: buildSeries() }],
    nodes: { 'Select pending': selectOut },
    nowMs: NOW,
  });

  const byTs = {};
  for (const it of classifyOut) byTs[it.json.ts_utc] = it.json.outcome_24h;

  check('long win -> target', byTs[iso(at(30))] === 'target', byTs[iso(at(30))]);
  check('short loss -> stop', byTs[iso(at(28))] === 'stop', byTs[iso(at(28))]);
  check('neither -> none', byTs[iso(at(27))] === 'none', byTs[iso(at(27))]);
  check('uncovered -> no_data', byTs[iso(at(50))] === 'no_data', byTs[iso(at(50))]);
  check('recent row never scored', byTs[iso(at(2))] === undefined, byTs[iso(at(2))]);

  const start = NOW - 25 * H;
  const barMs = 15 * 60000;
  async function boundaryCase(name, offset, touches, expected, direction = 'long', lastOpen = 24 * H) {
    const values = [];
    for (let elapsed = -barMs; elapsed <= lastOpen; elapsed += barMs) {
      const hit = touches[elapsed / barMs];
      values.push({ datetime: stamp(start + elapsed), high: String(hit?.[0] ?? 101), low: String(hit?.[1] ?? 100) });
    }
    const p = { ts_utc: iso(start + offset), startMs: start + offset, direction,
      stop: direction === 'long' ? 99 : 103, target: direction === 'long' ? 102 : 98 };
    const result = await runNode('tracker-02-classify.js', {
      input: [{ json: { status: 'ok', values } }],
      nodes: { 'Select pending': [{ json: { pending: [p] } }] }, nowMs: NOW,
    });
    const actual = result[0]?.json.outcome_24h;
    check(name, actual === expected, `expected ${expected}, got ${actual}`);
  }
  await boundaryCase('aligned entry target beats later stop', 0, { 0: [102, 100], 1: [101, 98] }, 'target');
  await boundaryCase('endpoint open is excluded', 0, { 96: [102, 98] }, 'none');
  await boundaryCase('partial entry target is ambiguous', 5 * 60000, { 0: [102, 100], 1: [101, 98] }, 'ambiguous');
  await boundaryCase('partial entry stop is ambiguous', 5 * 60000, { 0: [101, 98] }, 'ambiguous');
  await boundaryCase('partial entry short target is ambiguous', 5 * 60000, { 0: [101, 97] }, 'ambiguous', 'short');
  await boundaryCase('quiet partial entry permits interior outcome', 5 * 60000, { 1: [102, 100] }, 'target');
  await boundaryCase('partial endpoint target is ambiguous', 5 * 60000, { 96: [102, 100] }, 'ambiguous');
  await boundaryCase('interior outcome precedes partial endpoint', 5 * 60000, { 1: [102, 100], 96: [101, 98] }, 'target');
  await boundaryCase('full candle touching both stays stop', 0, { 1: [102, 98] }, 'stop');
  await boundaryCase('last complete candle covers exact endpoint', 0, {}, 'none', 'long', 24 * H - barMs);
  await boundaryCase('unfinished future stays pending', 0, {}, undefined, 'long', H);

  console.log(`\n${passed} checks passed`);
  if (failures.length) {
    console.log(`${failures.length} FAILED:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All tracker checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
