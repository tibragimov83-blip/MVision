const TIME_ZONE = 'America/New_York';
const HALF_HOUR = 30 * 60_000;
const DELIVERY_DELAY = 15 * 60_000;
const SYMBOL = '/GC:XCEC';
const BAR_SYMBOL = `${SYMBOL}{=30m}`;
const LEVEL_SYMBOL = `${SYMBOL}{=30m,pl=0.1}`;
const nyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export class AdapterError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function nyParts(ms) {
  return Object.fromEntries(nyFormat.formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function localHour(date, hour) {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(result);
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    result += target - local;
  }
  return result;
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function selectSession(date, now = Date.now()) {
  const p = nyParts(now);
  let candidate = date ?? `${p.year}-${p.month}-${p.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)
      || !Number.isFinite(Date.parse(`${candidate}T12:00:00Z`))
      || new Date(`${candidate}T12:00:00Z`).toISOString().slice(0, 10) !== candidate) {
    throw new AdapterError(400, 'invalid_session_date');
  }
  for (let i = 0; i < 8; i++, candidate = shiftDate(candidate, -1)) {
    const day = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    const end = localHour(candidate, 17);
    if (day > 0 && day < 6 && end + DELIVERY_DELAY <= now) {
      return { date: candidate, start: new Date(localHour(shiftDate(candidate, -1), 18)).toISOString(),
        end: new Date(end).toISOString(), timeZone: TIME_ZONE };
    }
    if (date !== undefined) throw new AdapterError(400, 'session_not_completed');
  }
  throw new AdapterError(400, 'invalid_session_date');
}

function requireValid(condition, code = 'invalid_upstream_data') {
  if (!condition) throw new AdapterError(502, code);
}

function volumeNumber(value) {
  requireValid(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function validPrices(e) {
  requireValid(['open', 'high', 'low', 'close'].every(key => Number.isFinite(e[key]) && e[key] > 0));
  requireValid(e.high >= Math.max(e.open, e.close) && e.low <= Math.min(e.open, e.close) && e.high >= e.low);
}

function classifiedVolumes(e) {
  const unknown = v => v === undefined || v === null || v === 'NaN' || Number.isNaN(v);
  let bid = unknown(e.bidVolume) ? null : volumeNumber(e.bidVolume);
  let ask = unknown(e.askVolume) ? null : volumeNumber(e.askVolume);
  requireValid((bid ?? 0) + (ask ?? 0) <= e.volume);
  if (bid === null && ask === e.volume) bid = 0;
  if (ask === null && bid === e.volume) ask = 0;
  if (e.volume === 0) bid = ask = 0;
  const unclassified = e.volume - (bid ?? 0) - (ask ?? 0);
  return { bid, ask, unclassified, complete: bid !== null && ask !== null && unclassified === 0 };
}

export function buildSummary({ bars, levels }, session, now = Date.now()) {
  const start = Date.parse(session.start), end = Date.parse(session.end);
  requireValid(end - start === 46 * HALF_HOUR && bars.length === 46, 'incomplete_session');
  bars = [...bars].sort((a, b) => a.time - b.time);
  const profile = new Map(), totals = new Map();
  let volume = 0, bid = 0, ask = 0, unclassified = 0, bidAskComplete = true;
  for (let i = 0; i < bars.length; i++) {
    const e = bars[i];
    requireValid(e.eventSymbol === BAR_SYMBOL && e.time === start + i * HALF_HOUR, 'incomplete_session');
    validPrices(e); volume += volumeNumber(e.volume);
    const sides = classifiedVolumes(e);
    bid += sides.bid ?? 0; ask += sides.ask ?? 0; unclassified += sides.unclassified;
    bidAskComplete &&= sides.complete;
  }
  const keys = new Set();
  for (const e of levels) {
    const slot = (e.time - start) / HALF_HOUR;
    requireValid(e.eventSymbol === LEVEL_SYMBOL && Number.isInteger(slot) && slot >= 0 && slot < 46);
    requireValid(Number.isSafeInteger(e.sequence) && e.sequence >= 0);
    const key = `${e.time}:${e.sequence}`;
    requireValid(!keys.has(key)); keys.add(key);
    validPrices(e);
    const tick = Math.round(e.close * 10);
    requireValid(['open', 'high', 'low', 'close'].every(k => Math.abs(e[k] * 10 - tick) < 1e-6));
    requireValid(e.low >= bars[slot].low - 1e-7 && e.high <= bars[slot].high + 1e-7);
    const count = volumeNumber(e.volume);
    totals.set(e.time, (totals.get(e.time) ?? 0) + count);
    profile.set(tick, (profile.get(tick) ?? 0) + count);
  }
  requireValid(Number.isSafeInteger(volume) && volume > 0 && profile.size > 0);
  for (const e of bars) requireValid(totals.get(e.time) === e.volume, 'profile_volume_mismatch');
  const prices = [...profile.keys()].sort((a, b) => a - b);
  const lowest = prices[0], highest = prices.at(-1);
  requireValid(highest - lowest <= 100_000, 'profile_too_large');
  let poc = lowest;
  for (const tick of prices) if (profile.get(tick) > profile.get(poc)) poc = tick;
  let low = poc, high = poc, included = profile.get(poc);
  while (included < volume * 0.7) {
    const below = low > lowest ? profile.get(low - 1) ?? 0 : -1;
    const above = high < highest ? profile.get(high + 1) ?? 0 : -1;
    if (below >= above) included += profile.get(--low) ?? 0;
    else included += profile.get(++high) ?? 0;
  }
  return {
    schemaVersion: 1, source: 'ATAS/dxFeed', symbol: SYMBOL, market: 'GC futures',
    generatedAt: new Date(now).toISOString(), session,
    summary: { open: bars[0].open, high: Math.max(...bars.map(e => e.high)),
      low: Math.min(...bars.map(e => e.low)), close: bars.at(-1).close, volume,
      poc: poc / 10, vah: high / 10, val: low / 10, valueAreaPercent: 70,
      bidVolume: bidAskComplete ? bid : null, askVolume: bidAskComplete ? ask : null,
      delta: bidAskComplete ? ask - bid : null },
    quality: { complete: true, barCount: bars.length, priceLevelCount: profile.size,
      unclassifiedVolume: unclassified, bidAskComplete },
    priceLevelSize: 0.1, volumeUnit: 'contracts', marketDataDelayMinutes: 15,
  };
}

export function readSnapshot(socket, token, session, signal) {
  const start = Date.parse(session.start), end = Date.parse(session.end);
  const streams = new Map([1, 3].map(channel => [channel, {
    symbol: channel === 1 ? BAR_SYMBOL : LEVEL_SYMBOL, rows: new Map(), begun: false, ended: false, pending: false,
  }]));
  return new Promise((resolve, reject) => {
    let finished = false, authorized = false, authSent = false, bytes = 0, events = 0;
    const send = value => socket.send(JSON.stringify(value));
    const finish = error => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', closed);
      socket.removeEventListener('error', failed);
      try { socket.close(1000, 'snapshot finished'); } catch { /* Already closed. */ }
      if (error) reject(error);
      else resolve({ bars: [...streams.get(1).rows.values()], levels: [...streams.get(3).rows.values()] });
    };
    const abort = () => finish(new AdapterError(504, 'upstream_timeout'));
    const failed = () => finish(new AdapterError(502, 'upstream_connection_failed'));
    const closed = () => finish(new AdapterError(502, 'incomplete_snapshot'));
    const message = event => {
      if (finished) return;
      try {
        requireValid(typeof event.data === 'string');
        bytes += event.data.length;
        requireValid(bytes <= 16_000_000, 'snapshot_too_large');
        const m = JSON.parse(event.data);
        requireValid(m && typeof m.type === 'string');
        if (m.type === 'ERROR' || m.type === 'CHANNEL_CLOSED') throw new AdapterError(502, 'upstream_rejected_request');
        if (m.type === 'KEEPALIVE') { send({ type: 'KEEPALIVE', channel: 0 }); return; }
        if (m.type === 'AUTH_STATE') {
          if (m.state === 'UNAUTHORIZED') {
            requireValid(!authSent, 'upstream_auth_failed'); authSent = true;
            send({ type: 'AUTH', channel: 0, token });
          } else if (m.state === 'AUTHORIZED' && !authorized) {
            authorized = true;
            for (const channel of streams.keys()) send({ type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } });
          }
        } else if (m.type === 'CHANNEL_OPENED') {
          requireValid(authorized && streams.has(m.channel) && m.service === 'FEED');
          send({ type: 'FEED_SETUP', channel: m.channel, acceptAggregationPeriod: 0.1, acceptDataFormat: 'FULL' });
          send({ type: 'FEED_SUBSCRIPTION', channel: m.channel,
            add: [{ type: 'Candle', symbol: streams.get(m.channel).symbol, fromTime: start }] });
        } else if (m.type === 'FEED_DATA') {
          const stream = streams.get(m.channel);
          requireValid(authorized && stream && Array.isArray(m.data));
          events += m.data.length; requireValid(events <= 100_000, 'snapshot_too_large');
          for (const e of m.data) {
            requireValid(e && e.eventType === 'Candle' && e.eventSymbol === stream.symbol);
            requireValid(Number.isSafeInteger(e.time) && Number.isSafeInteger(e.sequence) && e.sequence >= 0);
            requireValid(Number.isInteger(e.eventFlags) && e.eventFlags >= 0 && e.eventFlags <= 255);
            const flags = e.eventFlags;
            requireValid(!(flags & 16), 'truncated_snapshot');
            if (flags & 4) { stream.rows.clear(); stream.begun = true; stream.ended = false; }
            requireValid(stream.begun, 'snapshot_begin_missing');
            const key = `${e.time}:${e.sequence}`;
            if (e.time >= start && e.time < end) {
              if (flags & 2) stream.rows.delete(key);
              else stream.rows.set(key, e);
            }
            if (flags & 8) stream.ended = true;
            stream.pending = Boolean(flags & 1);
          }
          if ([...streams.values()].every(s => s.begun && s.ended && !s.pending)) finish();
        }
      } catch (error) {
        finish(error instanceof AdapterError ? error : new AdapterError(502, 'invalid_upstream_data'));
      }
    };
    socket.addEventListener('message', message);
    socket.addEventListener('close', closed);
    socket.addEventListener('error', failed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { send({ type: 'SETUP', channel: 0, version: '0.1-mvision/1.0', keepaliveTimeout: 30, acceptKeepaliveTimeout: 30 }); }
    catch { failed(); }
  });
}

export async function fetchSummary(session, {
  fetchImpl = fetch, openSocket, signal, now = Date.now(),
} = {}) {
  const json = async url => {
    const response = await fetchImpl(url, { signal });
    requireValid(response.ok, 'upstream_http_failed');
    return response.json();
  };
  const [auth, contract] = await Promise.all([
    json('https://online.atas.net/api/dxfeed/token'),
    json('https://online.atas.net/api/dxfeed/symbol?code=GC&exchange=NYMEX_Com&type=Continuous'),
  ]);
  requireValid(auth && typeof auth.token === 'string' && auth.token.length > 0 &&
    typeof auth.wsUrl === 'string' && /^wss:\/\/get-prod-dxlink-d15m\.dxfeed\.com\/delayed$/.test(auth.wsUrl),
  'invalid_upstream_configuration');
  requireValid(contract?.symbol === SYMBOL, 'unexpected_upstream_symbol');
  if (signal.aborted) throw new AdapterError(504, 'upstream_timeout');
  let socket;
  if (openSocket) socket = await openSocket(auth.wsUrl, signal);
  else {
    const response = await fetchImpl(auth.wsUrl.replace(/^wss:/, 'https:'), {
      headers: { Upgrade: 'websocket' }, signal,
    });
    requireValid(response.status === 101 && response.webSocket, 'upstream_connection_failed');
    socket = response.webSocket;
    socket.accept();
  }
  const snapshot = await readSnapshot(socket, auth.token, session, signal);
  return buildSummary(snapshot, session, now);
}

export async function handleRequest(request, env, options = {}) {
  const reply = (body, status = 200) => Response.json(body, { status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  // Authenticate before touching an upstream service. Only the adapter's own
  // bearer is accepted; temporary dxFeed tokens never leave this process.
  if (!env.ADAPTER_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADAPTER_TOKEN}`) {
    return reply({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  if (url.pathname !== '/summary') return reply({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if ([...url.searchParams.keys()].some(k => k !== 'date') || url.searchParams.getAll('date').length > 1) {
    return reply({ error: 'invalid_query' }, 400);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const now = options.now ?? Date.now();
    const session = selectSession(url.searchParams.get('date') ?? undefined, now);
    const summary = await fetchSummary(session, { ...options, signal: controller.signal, now });
    return reply(summary);
  } catch (error) {
    // Do not return exception messages: third-party responses may contain tokens.
    if (controller.signal.aborted) return reply({ error: 'upstream_timeout' }, 504);
    return reply({ error: error instanceof AdapterError ? error.message : 'invalid_upstream_data' },
      error instanceof AdapterError ? error.status : 502);
  } finally { clearTimeout(timer); }
}

export default { fetch: handleRequest };
