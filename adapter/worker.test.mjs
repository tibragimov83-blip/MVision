import test from 'node:test';
import assert from 'node:assert/strict';

test('selects the latest completed New York futures session', async () => {
  const adapter = await import('./worker.mjs').catch(() => ({}));
  assert.equal(typeof adapter.selectSession, 'function', 'session selector is not implemented');
  const session = adapter.selectSession(undefined, Date.parse('2026-10-22T21:15:00Z'));
  assert.deepEqual(session, {
    date: '2026-10-22', start: '2026-10-21T22:00:00.000Z', end: '2026-10-22T21:00:00.000Z',
    timeZone: 'America/New_York',
  });
});

test('handles weekends, the delay boundary, and both DST offsets', async () => {
  const { selectSession } = await import('./worker.mjs');
  for (const [now, date, start, end] of [
    ['2026-10-22T21:14:59Z', '2026-10-21', '2026-10-20T22:00:00.000Z', '2026-10-21T21:00:00.000Z'],
    ['2026-10-25T22:30:00Z', '2026-10-23', '2026-10-22T22:00:00.000Z', '2026-10-23T21:00:00.000Z'],
    ['2026-03-09T21:15:00Z', '2026-03-09', '2026-03-08T22:00:00.000Z', '2026-03-09T21:00:00.000Z'],
    ['2026-11-02T22:15:00Z', '2026-11-02', '2026-11-01T23:00:00.000Z', '2026-11-02T22:00:00.000Z'],
  ]) assert.deepEqual(selectSession(undefined, Date.parse(now)), { date, start, end, timeZone: 'America/New_York' });
});

test('rejects invalid dates, weekends and sessions not yet delivered', async () => {
  const { selectSession } = await import('./worker.mjs');
  for (const date of ['2026-02-30', '2026-1-02', '2026-10-24', '2026-10-23', 'nonsense']) {
    assert.throws(() => selectSession(date, Date.parse('2026-10-22T21:15:00Z')), { status: 400 });
  }
});

const session = { date: '2026-10-22', start: '2026-10-21T22:00:00.000Z',
  end: '2026-10-22T21:00:00.000Z', timeZone: 'America/New_York' };
const now = Date.parse('2026-10-22T21:15:00Z');
const BAR_SYMBOL = '/GC:XCEC{=30m}';
const LEVEL_SYMBOL = '/GC:XCEC{=30m,pl=0.1}';

function fixture() {
  const bars = [], levels = [];
  for (let n = 0; n < 46; n++) {
    const time = Date.parse(session.start) + n * 1_800_000;
    bars.push({ eventType: 'Candle', eventSymbol: BAR_SYMBOL, time, sequence: 0, eventFlags: 0,
      index: 7_680_000_000_000_000_000, open: 100, high: 100.2, low: 100, close: 100.1,
      volume: 100, bidVolume: 40, askVolume: 60 });
    for (const [sequence, price, volume] of [[1, 100, 20], [2, 100.1, 60], [3, 100.2, 20]]) {
      levels.push({ eventType: 'Candle', eventSymbol: LEVEL_SYMBOL, time, sequence, eventFlags: 0,
        index: 7_680_000_000_000_000_000, open: price, high: price, low: price, close: price,
        volume, bidVolume: 'NaN', askVolume: 'NaN' });
    }
  }
  return { bars, levels };
}

test('derives OHLC, classified delta and deterministic contiguous 70% value area', async () => {
  const { buildSummary } = await import('./worker.mjs');
  assert.equal(typeof buildSummary, 'function', 'summary is not implemented');
  const result = buildSummary(fixture(), session, now);
  assert.equal(result.source, 'ATAS/dxFeed');
  assert.equal(result.symbol, '/GC:XCEC');
  assert.deepEqual(result.summary, { open: 100, high: 100.2, low: 100, close: 100.1,
    volume: 4600, poc: 100.1, vah: 100.1, val: 100, valueAreaPercent: 70,
    bidVolume: 1840, askVolume: 2760, delta: 920 });
  assert.deepEqual(result.quality, { complete: true, barCount: 46, priceLevelCount: 3,
    unclassifiedVolume: 0, bidAskComplete: true });
  assert.deepEqual(result.session, session);
  assert.equal(result.generatedAt, '2026-10-22T21:15:00.000Z');
});

test('rejects shortened holidays, missing bars, broken OHLC and partial price-level totals', async () => {
  const { buildSummary } = await import('./worker.mjs');
  for (const damage of [
    x => x.bars.pop(), x => x.bars.push(x.bars[0]), x => x.bars[1].time++,
    x => x.levels.pop(), x => x.levels[0].volume = -1,
    x => x.levels[0].volume = 'NaN', x => x.bars[0].close = 200,
    x => x.levels[0].high = 100.1, x => x.levels[0].close = 100.05,
    x => x.levels[0].time++, x => x.bars[0].bidVolume = 101,
  ]) {
    const input = fixture(); damage(input);
    assert.throws(() => buildSummary(input, session, now), { status: 502 });
  }
});

test('unknown side is zero only when the opposite side accounts for all volume', async () => {
  const { buildSummary } = await import('./worker.mjs');
  const input = fixture();
  input.bars[0].bidVolume = 'NaN'; input.bars[0].askVolume = 100;
  assert.equal(buildSummary(input, session, now).summary.delta, 1000);
  input.bars[0].askVolume = 60;
  const unknown = buildSummary(input, session, now);
  assert.equal(unknown.summary.delta, null);
  assert.equal(unknown.summary.bidVolume, null);
  assert.equal(unknown.summary.askVolume, null);
  assert.equal(unknown.quality.bidAskComplete, false);
  assert.equal(unknown.quality.unclassifiedVolume, 40);
  input.bars[0].bidVolume = 20;
  assert.equal(buildSummary(input, session, now).quality.unclassifiedVolume, 20);
});

test('equal POC volumes choose the lowest price', async () => {
  const { buildSummary } = await import('./worker.mjs');
  const input = fixture();
  for (const e of input.levels) e.volume = e.sequence === 3 ? 0 : 50;
  assert.equal(buildSummary(input, session, now).summary.poc, 100);
});

// The socket is the external boundary. Protocol, snapshots and summaries remain real.
class FeedSocket extends EventTarget {
  constructor(sendEvents) { super(); this.sendEvents = sendEvents; this.closed = false; this.setup = new Set(); }
  emit(message) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))); }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.type === 'SETUP') {
      assert.equal(m.channel, 0); assert.equal(m.keepaliveTimeout, 30);
      this.emit({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' });
    } else if (m.type === 'AUTH') {
      assert.equal(m.token, 'upstream-test-token');
      this.emit({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' });
    } else if (m.type === 'CHANNEL_REQUEST') {
      assert.equal(m.service, 'FEED'); assert.equal(m.parameters.contract, 'AUTO');
      this.emit({ type: 'CHANNEL_OPENED', channel: m.channel, service: 'FEED' });
    } else if (m.type === 'FEED_SETUP') {
      assert.equal(m.acceptDataFormat, 'FULL'); this.setup.add(m.channel);
    } else if (m.type === 'FEED_SUBSCRIPTION') {
      assert.ok(this.setup.has(m.channel));
      assert.deepEqual(m.add, [{ type: 'Candle', symbol: m.channel === 1 ? BAR_SYMBOL : LEVEL_SYMBOL,
        fromTime: Date.parse(session.start) }]);
      this.sendEvents(m.channel, this);
    }
  }
  close() { this.closed = true; }
}

function snapshotEvents(events) {
  const data = events.map(e => ({ ...e }));
  data[0].eventFlags = 4; data.at(-1).eventFlags |= 8;
  return data;
}

async function socketRead(change, timeout = 200) {
  const { readSnapshot } = await import('./worker.mjs');
  assert.equal(typeof readSnapshot, 'function', 'snapshot reader is not implemented');
  const input = fixture();
  const socket = new FeedSocket((channel, ws) => {
    const events = snapshotEvents(channel === 1 ? input.bars : input.levels);
    const changed = change?.(events, channel, ws);
    if (changed !== false) ws.emit({ type: 'FEED_DATA', channel, data: events });
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const result = readSnapshot(socket, 'upstream-test-token', session, controller.signal).finally(() => clearTimeout(timer));
  return { result, socket };
}

test('completes both snapshots and deduplicates unsafe-index collisions by time and sequence', async () => {
  const { result, socket } = await socketRead(events => {
    const update = { ...events[1], volume: events[1].volume + 1 };
    events.splice(1, 0, update);
    // Exclude end boundary and allow snapshot markers carried on out-of-range events.
    events.push({ ...events.at(-1), time: Date.parse(session.end), eventFlags: 8 });
  });
  const snapshot = await result;
  assert.equal(snapshot.bars.length, 46); assert.equal(snapshot.levels.length, 138);
  assert.equal(snapshot.bars[1].volume, 100); assert.equal(socket.closed, true);
});

test('removals delete records before profile validation', async () => {
  const { buildSummary } = await import('./worker.mjs');
  const { result } = await socketRead((events, channel) => {
    if (channel === 3) events.splice(-1, 0, { ...events[1], eventFlags: 2 });
  });
  const snapshot = await result;
  assert.throws(() => buildSummary(snapshot, session, now), { status: 502 });
});

test('wrong symbols, malformed events and truncated snapshots fail closed', async () => {
  for (const damage of [
    e => e[1].eventSymbol = '/ES:XCME{=30m}',
    e => e[1].eventType = 'Quote', e => e[1].time = 'invalid',
    e => e[1].sequence = 1.2, e => e[1].eventFlags = -1,
    e => e.at(-1).eventFlags = 16,
  ]) {
    const { result, socket } = await socketRead(damage);
    await assert.rejects(result, { status: 502 }); assert.equal(socket.closed, true);
  }
});

test('waits for both snapshot ends and the last transaction, with bounded timeout', async () => {
  const { result, socket } = await socketRead((events, channel) => {
    if (channel === 3) events.at(-1).eventFlags = 0;
  }, 15);
  await assert.rejects(result, { status: 504 }); assert.equal(socket.closed, true);
  const pending = await socketRead((events, channel, ws) => {
    if (channel === 3) {
      events.at(-1).eventFlags = 9;
      setTimeout(() => ws.emit({ type: 'FEED_DATA', channel, data: [{ ...events.at(-1), eventFlags: 0 }] }), 5);
    }
  });
  assert.equal((await pending.result).levels.length, 138);
});

function upstreamOptions(change = {}, workerTransport = false) {
  const input = fixture();
  const socket = new FeedSocket((channel, ws) => ws.emit({ type: 'FEED_DATA', channel,
    data: snapshotEvents(channel === 1 ? input.bars : input.levels) }));
  socket.accept = () => { socket.accepted = true; };
  const fetchImpl = async (url, options) => {
    if (url === 'https://online.atas.net/api/dxfeed/token') return Response.json(change.token ?? {
      token: 'upstream-test-token', wsUrl: 'wss://get-prod-dxlink-d15m.dxfeed.com/delayed',
    });
    if (url === 'https://online.atas.net/api/dxfeed/symbol?code=GC&exchange=NYMEX_Com&type=Continuous') {
      return Response.json(change.symbol ?? { symbol: '/GC:XCEC' });
    }
    assert.equal(url, 'https://get-prod-dxlink-d15m.dxfeed.com/delayed');
    assert.equal(options.headers.Upgrade, 'websocket');
    return { status: 101, webSocket: socket };
  };
  return { now, fetchImpl, ...(workerTransport ? {} : { openSocket: async () => socket }), socket };
}

test('authenticates HTTP before any upstream request and forbids arbitrary queries', async () => {
  const { handleRequest } = await import('./worker.mjs');
  assert.equal(typeof handleRequest, 'function', 'HTTP endpoint is not implemented');
  const options = { fetchImpl: () => assert.fail('unauthorized request reached upstream') };
  for (const [authorization, env] of [[null, {}], ['Bearer test-secret', {}],
    ['Bearer wrong', { ADAPTER_TOKEN: 'test-secret' }], [null, { ADAPTER_TOKEN: 'test-secret' }]]) {
    const r = await handleRequest(new Request('https://adapter.example/summary', {
      headers: authorization ? { Authorization: authorization } : {},
    }), env, options);
    assert.equal(r.status, 401); assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
  for (const query of ['?symbol=GC', '?url=https://evil.example', '?date=bad', '?date=2026-10-21&date=2026-10-22']) {
    const r = await handleRequest(new Request(`https://adapter.example/summary${query}`, {
      headers: { Authorization: 'Bearer test-secret' },
    }), { ADAPTER_TOKEN: 'test-secret' }, { ...options, now });
    assert.equal(r.status, 400);
  }
});

test('HTTP returns the versioned summary through the Cloudflare upgrade transport', async () => {
  const { handleRequest } = await import('./worker.mjs');
  const options = upstreamOptions({}, true);
  const r = await handleRequest(new Request('https://adapter.example/summary?date=2026-10-22', {
    headers: { Authorization: 'Bearer test-secret' },
  }), { ADAPTER_TOKEN: 'test-secret' }, options);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.schemaVersion, 1); assert.equal(body.summary.volume, 4600);
  assert.equal(body.summary.poc, 100.1); assert.equal(body.quality.complete, true);
  assert.equal(options.socket.accepted, true); assert.equal(options.socket.closed, true);
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('rejects altered symbol, untrusted WebSocket URL and malformed upstream JSON without leaking secrets', async () => {
  const { handleRequest } = await import('./worker.mjs');
  for (const options of [
    upstreamOptions({ token: { token: 'upstream-test-token', wsUrl: 'wss://evil.example/delayed' } }),
    upstreamOptions({ token: { token: '', wsUrl: 'wss://get-prod-dxlink-d15m.dxfeed.com/delayed' } }),
    upstreamOptions({ symbol: { symbol: '/ES:XCME' } }),
    { now, fetchImpl: async () => { throw new Error('secret upstream-test-token'); } },
    { now, fetchImpl: async () => new Response('secret upstream-test-token', { status: 403 }) },
    { now, fetchImpl: async () => new Response('not JSON') },
  ]) {
    const r = await handleRequest(new Request('https://adapter.example/summary', {
      headers: { Authorization: 'Bearer test-secret' },
    }), { ADAPTER_TOKEN: 'test-secret' }, options);
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes('secret'), false);
  }
});

test('returns 504 when upstream HTTP exceeds the shared deadline', async () => {
  const { handleRequest } = await import('./worker.mjs');
  const r = await handleRequest(new Request('https://adapter.example/summary', {
    headers: { Authorization: 'Bearer test-secret' },
  }), { ADAPTER_TOKEN: 'test-secret' }, { now, timeoutMs: 10, fetchImpl: async (_, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.equal(r.status, 504);
});
