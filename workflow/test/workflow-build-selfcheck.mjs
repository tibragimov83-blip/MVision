import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root, 'build.mjs')]);
const load = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const main = load('gold-signals-main.json');
const tracker = load('gold-signals-tracker.json');
const node = (flow, name) => flow.nodes.find(n => n.name === name);
const next = (flow, name) => flow.connections[name].main[0].map(n => n.node);
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
await check('Telegram succeeds before the Sheets write; a failed write cannot stop delivery', () => {
  assert.deepEqual(next(main, 'Format message'), ['Send to channel']);
  assert.deepEqual(next(main, 'Send to channel'), ['Log row']);
});
await check('Sheets append/update retry then fail visibly', () => {
  for (const n of [node(main, 'Log to Sheets'), node(tracker, 'Update outcome')]) {
    assert.equal(n.retryOnFail, true);
    assert.equal(n.maxTries, 3);
    assert.equal(n.onError, 'stopWorkflow');
  }
  assert.equal(node(main, 'Log to Sheets').parameters.operation, 'appendOrUpdate');
  assert.deepEqual(node(main, 'Log to Sheets').parameters.columns.matchingColumns, ['ts_utc']);
});
await check('Telegram response cannot erase the logged signal or add unwanted columns', () => {
  const signal = { ts_utc: '2026-10-22T10:00:00Z', price: 4400, score: 0, notified: false,
    messageHtml: 'not a sheet column', outcome_24h: null };
  const input = { first: () => ({ json: { ok: true, result: { message_id: 123 } } }) };
  const ref = name => { assert.equal(name, 'Format message'); return { first: () => ({ json: signal }) }; };
  const out = new Function('$input', '$', node(main, 'Log row').parameters.jsCode)(input, ref);
  assert.equal(out[0].json.price, 4400);
  assert.equal(out[0].json.score, 0);
  assert.equal(out[0].json.notified, false);
  assert.equal(out[0].json.outcome_24h, '');
  assert.equal(Object.keys(out[0].json).length, 16);
  assert.equal('messageHtml' in out[0].json, false);
});
await check('ATAS workflows are isolated and refuse missing configuration before any external calls', () => {
  for (const file of ['gold-signals-atas-main.json', 'gold-signals-atas-tracker.json', 'gold-signals-atas-daily.json']) {
    const flow = load(file);
    assert.equal(flow.active, false);
    const trigger = flow.nodes.find(n => n.type === 'n8n-nodes-base.scheduleTrigger');
    assert.deepEqual(next(flow, trigger.name), ['Check configuration']);
    const guard = node(flow, 'Check configuration');
    const missingChannel = guard.parameters.jsCode.replace(/"channelId":"[^"]*"/, '"channelId":""');
    assert.throws(() => new Function('$input', missingChannel)({ all: () => [{ json: {} }] }), /configure/i);
    for (const n of flow.nodes) {
      if (n.type === 'n8n-nodes-base.telegram') assert.notEqual(n.parameters.chatId, node(main, 'Send to channel').parameters.chatId);
      if (n.type === 'n8n-nodes-base.googleSheets') assert.notEqual(n.parameters.sheetName.value, 'signals');
    }
  }
});
await check('ATAS context is separate from scoring and marks a session only after Telegram succeeds', () => {
  const flow = load('gold-signals-atas-daily.json');
  assert.deepEqual(next(flow, 'Format ATAS context'), ['Send ATAS context']);
  assert.deepEqual(next(flow, 'Send ATAS context'), ['Mark session posted']);
  assert.equal(node(load('gold-signals-atas-main.json'), 'Scorer').parameters.jsCode, node(main, 'Scorer').parameters.jsCode);
  const request = node(flow, 'Fetch ATAS summary');
  assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(request.onError, 'stopWorkflow');
});
console.log(`${passed} workflow checks passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
