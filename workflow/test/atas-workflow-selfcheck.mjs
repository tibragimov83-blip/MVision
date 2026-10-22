import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSummary, selectSession } from '../../adapter/worker.mjs';

const now = Date.parse('2026-10-22T22:30:00Z');
class Clock extends Date { static now() { return now; } }
const session = selectSession(undefined, now);
const bars = [], levels = [];
for (let i = 0; i < 46; i++) {
  const time = Date.parse(session.start) + i * 1800000;
  bars.push({ eventSymbol: '/GC:XCEC{=30m}', time, open: 4400, high: 4400.1, low: 4400,
    close: 4400.1, volume: 100, bidVolume: 40, askVolume: 60 });
  for (let j = 0; j < 2; j++) levels.push({ eventSymbol: '/GC:XCEC{=30m,pl=0.1}', time, sequence: j,
    open: 4400 + j / 10, high: 4400 + j / 10, low: 4400 + j / 10, close: 4400 + j / 10, volume: 50 });
}
const body = () => structuredClone(buildSummary({ bars, levels }, session, now));
const source = name => fs.readFileSync(new URL(`../code/${name}`, import.meta.url), 'utf8');
const format = (data, state = {}) => new Function('$input', '$getWorkflowStaticData', 'Date', source('atas-format.js'))(
  { first: () => ({ json: data }) }, () => state, Clock);
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
check('real adapter summary becomes labelled futures context with levels and delta', () => {
  const state = {}, [item] = format(body(), state);
  assert.equal(item.json.sessionDate, '2026-10-22');
  for (const text of ['GC futures', '22.10.2026', 'Нью-Йорк', '4,400.00', '+920', 'не опционы']) {
    assert.ok(item.json.messageHtml.includes(text), text);
  }
  assert.deepEqual(state, {}, 'formatting must not acknowledge delivery');
});
check('incomplete/stale/incorrect summaries fail before a Telegram message exists', () => {
  for (const change of [
    x => x.quality.complete = false, x => x.quality.barCount = 45,
    x => x.generatedAt = '2026-10-22T21:00:00Z', x => x.generatedAt = 'bad',
    x => x.symbol = 'XAU/USD', x => x.summary.volume = '4600',
    x => x.summary.poc = 0, x => x.summary.vah = 4399,
    x => x.summary.delta++, x => x.summary.askVolume = null,
    x => x.session.date = '2026-10-21', x => x.session.end = '2026-10-22T22:00:00Z',
    x => x.session.timeZone = 'UTC', x => x.summary.valueAreaPercent = 80,
  ]) { const data = body(); change(data); assert.throws(() => format(data), /invalid/); }
});
check('unknown delta stays explicitly unavailable', () => {
  const data = body(); data.summary.bidVolume = null; data.summary.askVolume = null;
  data.summary.delta = null; data.quality.unclassifiedVolume = 1;
  assert.ok(format(data)[0].json.messageHtml.includes('н/д'));
});
check('acknowledgement after delivery suppresses the same or older session', () => {
  const state = {}, [formatted] = format(body(), state);
  new Function('$', '$getWorkflowStaticData', source('atas-mark-posted.js'))(
    name => { assert.equal(name, 'Format ATAS context'); return { first: () => formatted }; }, () => state);
  assert.equal(state.atasLastPostedSession, '2026-10-22');
  assert.deepEqual(format(body(), state), []);
  assert.deepEqual(format(body(), { atasLastPostedSession: '2026-10-23' }), []);
});
check('configured flow passes; old channel/tab, missing alert route, and unsafe adapter URL refuse', () => {
  const config = { channelId: '-1003977702706', sheetDocumentId: 'sheet-id', sheetName: 'signals_atas',
    adapterUrl: 'https://mvision-atas.example.workers.dev', errorWorkflowId: 'error-handler-id' };
  const run = settings => new Function('config', 'requireAdapter', 'originalChannel', 'originalSheet', '$input',
    source('atas-check-config.js'))(settings, true, '-1004334466444', 'signals', { all: () => [{ json: {} }] });
  assert.equal(run(config)[0].json.adapterUrl, config.adapterUrl);
  for (const patch of [ { channelId: '-1004334466444' }, { sheetName: 'signals' }, { errorWorkflowId: '' },
    { adapterUrl: 'http://localhost' }, { adapterUrl: 'https://user:password@host.com' }, { adapterUrl: '' } ]) {
    assert.throws(() => run({ ...config, ...patch }), /Configure/);
  }
});
console.log(`${passed} ATAS workflow checks passed.`);
