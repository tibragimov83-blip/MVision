// Behavioral checks for closed candles, companion freshness and calendar expiry.
// Run: node workflow/test/market-guards-selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const code = (file) => fs.readFileSync(new URL(`../code/${file}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-08-19T14:10:00Z');
const DAY = 86400000;
const IV = { '15min': 900000, '1h': 3600000, '1day': DAY };

async function run(file, { input = [], plan = PLAN, sd = {}, now = NOW, http } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fn = new Function('$input', '$', '$getWorkflowStaticData', 'Date', 'console',
    `return (async () => { ${code(file)}\n })();`);
  return fn.call({ helpers: { httpRequest: http || (() => { throw new Error('offline'); }) } },
    { all: () => input, first: () => input[0] }, () => ({ all: () => plan }),
    () => sd, Clock, { log() {} });
}

const PLAN = await run('01-fetch-plan.js', { plan: [] });
const stamp = (time, interval) => new Date(time).toISOString()
  .slice(0, interval === '1day' ? 10 : 19).replace('T', ' ');

function responses(now = NOW, plan = PLAN) {
  return plan.map(({ json: row }) => {
    const step = IV[row.interval];
    const latest = Math.floor(now / step) * step - step;
    const count = row.role === 'dollar_proxy' ? 20 : { '15min': 100, '1h': 200, '1day': 60 }[row.interval];
    return { json: {
      status: 'ok', meta: { symbol: row.symbol, interval: row.interval },
      values: Array.from({ length: count }, (_, i) => ({
        datetime: stamp(latest - i * step, row.interval),
        open: String(2400 - i / 2), high: String(2404 - i / 2),
        low: String(2396 - i / 2), close: String(2401 - i / 2),
      })),
    } };
  });
}

const indicators = (input = responses(), options = {}) => run('02-indicators.js', { input, ...options });
const shift = (input, index, amount) => {
  const body = input[index].json;
  body.values = body.values.map((v) => ({ ...v,
    datetime: stamp(Date.parse(v.datetime.length === 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(' ', 'T')}Z`) - amount, body.meta.interval),
  }));
  return input;
};

test('closed-only indicators ignore forming and future candles in every series', async () => {
  const clean = await indicators();
  const dirty = responses();
  for (const { json: body } of dirty) {
    const step = IV[body.meta.interval];
    for (const time of [Math.floor(NOW / step) * step, NOW + DAY]) {
      body.values.unshift({ datetime: stamp(time, body.meta.interval),
        open: '9990', high: '10000', low: '9980', close: '9999' });
    }
  }
  assert.deepEqual(await indicators(dirty), clean);
});

test('bar closing exactly at decision time is included', async () => {
  const now = Date.parse('2026-08-19T14:00:00Z');
  const out = await indicators(responses(now), { now });
  assert.equal(out[0].json.last15.datetime, '2026-08-19 13:45:00');
  assert.equal(out[0].json.ema200 !== null, true);
});

test('fetch buffer retains 200 closed hourly bars when latest bar is forming', async () => {
  const row = PLAN.find(({ json }) => json.symbol === 'XAU/USD' && json.interval === '1h').json;
  assert.equal(row.outputsize, 201);
  const input = responses();
  const h1 = input.find(({ json }) => json.meta.symbol === row.symbol && json.meta.interval === row.interval).json;
  h1.values.unshift({ ...h1.values[0], datetime: '2026-08-19 14:00:00', close: '9999' });
  h1.values = h1.values.slice(0, row.outputsize);
  const out = await indicators(input);
  assert.notEqual(out[0].json.ema200, null);
  assert.deepEqual(out, await indicators());
});

for (const [index, name] of ['15min', '1h', '1day', 'FX'].entries()) {
  test(`week-old ${name} blocks a signal even when all companion series are fresh`, async () => {
    const sd = {};
    assert.deepEqual(await indicators(shift(responses(), index, 7 * DAY), { sd }), []);
    assert.equal(sd.skipped, 1);
  });
}

test('missing configured FX series fails visibly', async () => {
  await assert.rejects(indicators(responses().slice(0, 3)), /Missing EUR\/USD 1h/);
});

test('forming-only required series cannot produce indicators', async () => {
  const input = responses();
  input[0].json.values = [{ ...input[0].json.values[0], datetime: '2026-08-19 14:00:00' }];
  assert.deepEqual(await indicators(input), []);
});

test('daily indicators use full UTC days, ignoring today before midnight', async () => {
  const input = responses();
  const daily = input[2].json;
  daily.values.unshift({ ...daily.values[0], datetime: '2026-08-19', high: '9999', close: '9998' });
  const result = await indicators(input);
  assert.deepEqual(result, await indicators());
  assert.equal(result[0].json.priorDayDate, '2026-08-18');
});

for (const [nowIso, allow] of [
  ['2026-08-24T14:10:00Z', true], // Monday: Friday daily bar is normal.
  ['2026-08-25T14:10:00Z', true], // Tuesday: allow Monday holiday.
  ['2026-08-26T14:10:00Z', false], // Wednesday: two missing weekdays is stale.
]) {
  test(`Friday daily history on ${nowIso.slice(0, 10)} is ${allow ? 'usable' : 'stale'}`, async () => {
    const now = Date.parse(nowIso);
    const input = responses(now);
    const latestDaily = Date.parse(`${input[2].json.values[0].datetime}T00:00:00Z`);
    shift(input, 2, latestDaily - Date.parse('2026-08-21T00:00:00Z'));
    assert.equal((await indicators(input, { now })).length > 0, allow);
  });
}

test('hourly and FX freshness allow the normal close gap but reject three missed hours', async () => {
  assert.equal((await indicators()).length, 1);
  for (const index of [1, 3]) {
    assert.deepEqual(await indicators(shift(responses(), index, 3 * 3600000)), []);
  }
});

for (const [reopen, fridayHour, fridayDate] of [
  ['2026-08-23T22:30:00Z', '2026-08-21T20:00:00Z', '2026-08-21'],
  ['2026-11-01T23:30:00Z', '2026-10-30T21:00:00Z', '2026-10-30'],
]) {
  test(`weekend reopen ${reopen} waits for a fresh closed hour instead of reusing Friday`, async () => {
    const now = Date.parse(reopen), input = responses(now);
    for (const i of [1, 3]) {
      const latest = Date.parse(`${input[i].json.values[0].datetime.replace(' ', 'T')}Z`);
      shift(input, i, latest - Date.parse(fridayHour));
    }
    const latestDay = Date.parse(`${input[2].json.values[0].datetime}T00:00:00Z`);
    shift(input, 2, latestDay - Date.parse(`${fridayDate}T00:00:00Z`));
    assert.deepEqual(await indicators(input, { now }), []);
    const nextHour = now + 30 * 60000, fresh = responses(nextHour);
    const daily = Date.parse(`${fresh[2].json.values[0].datetime}T00:00:00Z`);
    shift(fresh, 2, daily - Date.parse(`${fridayDate}T00:00:00Z`));
    assert.equal((await indicators(fresh, { now: nextHour })).length, 1);
  });
}

function calendarState(ageHours, events = [{ title: 'CPI', ts: NOW + 30 * 60000 }]) {
  return { calendarEvents: events, calendarFetchedAt: new Date(NOW - ageHours * 3600000).toISOString() };
}
const gate = async (sd, http) => (await run('03-event-gate.js', { input: [{ json: {} }], sd, http }))[0].json.eventGate;

for (const age of [25, 7 * 24, -1]) {
  test(`calendar cache age ${age}h cannot imply known event coverage after fetch failure`, async () => {
    const result = await gate(calendarState(age));
    assert.equal(result.eventDataUnknown, true);
    assert.equal(result.minutesToNext, null);
    assert.equal(result.calendarSource, 'unavailable');
  });
}

test('invalid calendar fetch timestamp cannot imply known coverage', async () => {
  const sd = calendarState(1);
  sd.calendarFetchedAt = 'not-a-date';
  assert.equal((await gate(sd)).eventDataUnknown, true);
});

test('eight-hour cache preserves imminent-event protection during a brief outage', async () => {
  const result = await gate(calendarState(8));
  assert.equal(result.eventDataUnknown, false);
  assert.equal(result.calendarStale, true);
  assert.equal(result.minutesToNext, 30);
});

test('recent empty calendar remains known coverage during an outage', async () => {
  const result = await gate(calendarState(8, []));
  assert.equal(result.eventDataUnknown, false);
  assert.equal(result.calendarStale, true);
});

test('fresh fetch replaces expired coverage and clears unknown risk', async () => {
  const sd = calendarState(7 * 24);
  const result = await gate(sd, async () => [{ country: 'USD', impact: 'High', title: 'CPI',
    date: new Date(NOW + 30 * 60000).toISOString() }]);
  assert.equal(result.eventDataUnknown, false);
  assert.equal(result.calendarSource, 'fetched');
  assert.equal(result.minutesToNext, 30);
  assert.equal(sd.calendarFetchedAt, new Date(NOW).toISOString());
});
