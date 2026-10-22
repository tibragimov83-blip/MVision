/* ============================================================================
 * BACKTEST 1/2 — fetch history (run once)
 * ----------------------------------------------------------------------------
 *   TWELVEDATA_KEY=xxxx node workflow/backtest/fetch-history.mjs [--force]
 *
 * Pulls the same four series the live workflow uses (XAU/USD 15min/1h/1day +
 * EUR/USD 1h) at the API's max outputsize and caches each raw response under
 * backtest/data/. The replay then runs entirely offline against these files,
 * so re-runs cost no API calls and burn no quota.
 *
 * The key is read from the environment only — never written to disk, never a
 * CLI arg (which would land in shell history). The cache holds market data,
 * not the key.
 *
 * ceiling: outputsize 5000 => ~5000 15min bars ≈ 7 weeks of 24/5 gold. That is
 * the replay window. To backtest longer, paginate with start_date/end_date
 * here — the replay downstream doesn't care how many bars it gets.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');

const KEY = process.env.TWELVEDATA_KEY;
if (!KEY) {
  console.error('Set TWELVEDATA_KEY in the environment. Aborting (no key, no fetch).');
  process.exit(1);
}

const force = process.argv.includes('--force');

// Mirrors 01-fetch-plan.js. outputsize bumped to the API max so there is deep
// trailing history for indicators at every replay step.
const SERIES = [
  { symbol: 'XAU/USD', interval: '15min' },
  { symbol: 'XAU/USD', interval: '1h' },
  { symbol: 'XAU/USD', interval: '1day' },
  { symbol: 'EUR/USD', interval: '1h' },
];
const OUTPUTSIZE = 5000;

function fileFor(s) {
  const safe = `${s.symbol}_${s.interval}`.replace(/[^\w]+/g, '');
  return path.join(DATA, `${safe}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSeries(s) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(s.symbol)}` +
    `&interval=${encodeURIComponent(s.interval)}&outputsize=${OUTPUTSIZE}&timezone=UTC&apikey=${KEY}`;
  const res = await fetch(url);
  const body = await res.json();
  if (body.status !== 'ok' || !Array.isArray(body.values)) {
    throw new Error(`${s.symbol} ${s.interval}: ${body.message || JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  for (const s of SERIES) {
    const out = fileFor(s);
    if (!force && fs.existsSync(out)) {
      console.log(`skip  ${s.symbol} ${s.interval} (cached — use --force to refetch)`);
      continue;
    }
    process.stdout.write(`fetch ${s.symbol} ${s.interval} … `);
    const body = await fetchSeries(s);
    fs.writeFileSync(out, JSON.stringify(body));
    console.log(`${body.values.length} bars`);
    await sleep(8000); // free tier: 8 req/min — stay well under it
  }
  console.log('Done. Now run: node workflow/backtest/replay.mjs');
}

main().catch((e) => {
  console.error('Fetch failed:', e.message);
  process.exit(1);
});
