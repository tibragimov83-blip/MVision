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

  console.log(`\n${passed} checks passed`);
  if (failures.length) {
    console.log(`${failures.length} FAILED:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All tracker checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
