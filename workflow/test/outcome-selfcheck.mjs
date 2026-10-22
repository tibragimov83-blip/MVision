import assert from 'node:assert/strict';
import { classifyOutcome, closedCacheValues } from '../backtest/replay.mjs';

const H = 3600000;
const B = 15 * 60000;
const start = Date.UTC(2026, 9, 23, 20); // Friday; Monday's target is outside 24 elapsed hours.
const b = (hours, high = 101, low = 100) => ({ t: start + hours * H, high, low });
const full = () => Array.from({ length: 96 }, (_, i) => b(i / 4));
const wednesday = Date.parse('2026-10-21T14:00:00Z');
const w = (quarters, high = 101, low = 100) => ({ t: wednesday + quarters * B, high, low });
const cases = [
  ['weekend target outside elapsed horizon', [b(0), b(.25), b(.5), b(.75), b(60, 103)], 'timeout'],
  ['truncated observation cannot timeout', [b(0), b(0.25)], 'pending'],
  ['entry candle is included', [b(0, 102), b(24)], 'win'],
  ['endpoint candle is excluded', [...full(), b(24, 102, 98)], 'timeout'],
  ['complete last candle closes at endpoint', full(), 'timeout'],
  ['early hit with incomplete future is completed', [b(0, 102)], 'win'],
];
const additional = [
  ['missing interior candle cannot imply a win', [w(0), w(2, 103)], 'no_data'],
  ['missing interior candles cannot imply timeout', [w(0), w(95)], 'no_data'],
  ['known early result survives a later missing candle', [w(0, 103), w(95)], 'win'],
];
let failed = 0;
for (const [name, bars, expected] of cases) {
  try { assert.equal(classifyOutcome('long', 99, 102, bars, start), expected, name); }
  catch (e) { failed++; console.error(e.message); }
}
for (const [name, bars, expected] of additional) {
  try { assert.equal(classifyOutcome('long', 99, 102, bars, wednesday), expected, name); }
  catch (e) { failed++; console.error(e.message); }
}
try {
  const values = [0, 1, 2].map(i => ({ datetime: `2026-10-21 14:${String(i * 15).padStart(2, '0')}:00` }));
  const body = { values, _mvisionFetchedAt: '2026-10-21T14:35:00Z' };
  assert.deepEqual(closedCacheValues(body, B).map(v => v.datetime), [values[0].datetime, values[1].datetime]);
  const closed = closedCacheValues(body, B).map(v => ({ t: Date.parse(`${v.datetime.replace(' ', 'T')}Z`), high: 101, low: 100 }));
  assert.equal(classifyOutcome('long', 99, 102, closed, wednesday, 3 * B), 'pending');
  assert.deepEqual(closedCacheValues({ values }, B).map(v => v.datetime), [values[0].datetime, values[1].datetime]);
} catch (e) { failed++; console.error('snapshot capture closes candles:', e.message); }
console.log(`${cases.length + additional.length + 1 - failed}/${cases.length + additional.length + 1} outcome checks passed`);
if (failed) process.exitCode = 1;
