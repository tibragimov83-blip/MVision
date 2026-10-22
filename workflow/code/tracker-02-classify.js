/* ============================================================================
 * TRACKER 2/2 — Classify outcomes
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Input: ONE Twelve Data 15min response (the single Fetch call).
 * Also reads the pending rows from the Select node by reference.
 *
 * For each pending row it walks the 15min bars inside [ts_utc, ts_utc+24h) and
 * asks the same question the backtest asks: did price reach the target or the
 * stop FIRST? Writes one of:
 *   target  — target hit first  (a win)
 *   stop    — stop hit first, or the bar spanned both (conservative)  (a loss)
 *   none    — neither within 24h
 *   no_data — uncovered entry or missing candles during expected market hours
 *   ambiguous — a partial boundary candle touched a level; intrabar time unknown
 *
 * The walk is shared with classifyOutcome in
 * workflow/backtest/replay.mjs, so live outcomes and backtest outcomes mean the
 * same thing and can be compared directly. tracker-selfcheck.mjs pins them to
 * the same fixtures.
 * ==========================================================================*/

const WINDOW_MS = 24 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000; // API timestamps are candle OPEN times.
const GOLD_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
});

// Normal gold closures only. Holidays or unexplained missing open-market bars
// remain unscorable; a later candle cannot establish what happened in a hole.
function closedGap(from, to) {
  for (let t = from; t < to; t = Math.min(to, Math.floor(t / BAR_MS) * BAR_MS + BAR_MS)) {
    const p = Object.fromEntries(GOLD_CLOCK.formatToParts(t).map(x => [x.type, x.value]));
    const h = Number(p.hour);
    if (!(p.weekday === 'Sat' || (p.weekday === 'Fri' && h >= 17) ||
        (p.weekday === 'Sun' && h < 18) || (p.weekday !== 'Sun' && h === 17))) return false;
  }
  return true;
}

function parseBarTime(dt) {
  if (!dt) return null;
  const iso = dt.length <= 10 ? `${dt}T00:00:00Z` : `${dt.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Oldest-first bars. Full candles touching both levels remain conservative. */
function classify(direction, stop, target, bars) {
  for (const b of bars) {
    const hitStop = direction === 'long' ? b.low <= stop : b.high >= stop;
    const hitTarget = direction === 'long' ? b.high >= target : b.low <= target;
    if (b.partial && (hitStop || hitTarget)) return 'ambiguous';
    if (hitStop && hitTarget) return 'stop';
    if (hitTarget) return 'target';
    if (hitStop) return 'stop';
  }
  return 'none';
}

/** Closed bars, oldest-first. Only complete observation windows can time out. */
function classifyObservation(direction, stop, target, bars, startMs, endMs = startMs + WINDOW_MS) {
  if (!bars.length) return 'pending';
  if (startMs < bars[0].t) return 'no_data';
  const windowBars = bars
    .filter((b) => b.t < endMs && b.t + BAR_MS > startMs)
    .map((b) => ({ ...b, partial: b.t < startMs || b.t + BAR_MS > endMs }));
  let cursor = startMs;
  for (const b of windowBars) {
    if (b.t > cursor && !closedGap(cursor, b.t)) return 'no_data';
    const outcome = classify(direction, stop, target, [b]);
    if (outcome !== 'none') return outcome;
    cursor = Math.max(cursor, b.t + BAR_MS);
  }
  if (cursor >= endMs || closedGap(cursor, endMs)) return 'none';
  return bars[bars.length - 1].t + BAR_MS >= endMs ? 'no_data' : 'pending';
}

// --- n8n input (replay loads the pure functions above this marker) ---
const body = $input.first().json;
if (!body || body.status !== 'ok' || !Array.isArray(body.values)) {
  const detail = body && body.message ? body.message : JSON.stringify(body).slice(0, 200);
  throw new Error(`Twelve Data fetch for outcome tracking failed: ${detail}`);
}

const bars = body.values
  .map((v) => ({ t: parseBarTime(v.datetime), high: parseFloat(v.high), low: parseFloat(v.low) }))
  .filter((b) => b.t !== null && b.t + BAR_MS <= Date.now() && Number.isFinite(b.high) && Number.isFinite(b.low))
  .sort((a, b) => a.t - b.t); // oldest-first

const pending = ($('Select pending').first().json.pending) || [];

const out = [];
for (const p of pending) {
  const end = p.startMs + WINDOW_MS;

  // No usable closed candles — can't score the row honestly.
  if (bars.length === 0) {
    out.push({ json: { ts_utc: p.ts_utc, outcome_24h: 'no_data' }, pairedItem: { item: 0 } });
    continue;
  }
  const outcome = classifyObservation(p.direction, p.stop, p.target, bars, p.startMs, end);
  // Window hasn't fully elapsed in the data yet — leave blank, retry tomorrow.
  if (outcome === 'pending') continue;
  out.push({ json: { ts_utc: p.ts_utc, outcome_24h: outcome }, pairedItem: { item: 0 } });
}

return out;
