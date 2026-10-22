/* ============================================================================
 * TRACKER 2/2 — Classify outcomes
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Input: ONE Twelve Data 15min response (the single Fetch call).
 * Also reads the pending rows from the Select node by reference.
 *
 * For each pending row it walks the 15min bars inside [ts_utc, ts_utc+24h] and
 * asks the same question the backtest asks: did price reach the target or the
 * stop FIRST? Writes one of:
 *   target  — target hit first  (a win)
 *   stop    — stop hit first, or the bar spanned both (conservative)  (a loss)
 *   none    — neither within 24h
 *   no_data — the fetched window did not cover this row (tracker was down > ~5d)
 *
 * The walk is intentionally identical to classifyOutcome in
 * workflow/backtest/replay.mjs, so live outcomes and backtest outcomes mean the
 * same thing and can be compared directly. tracker-selfcheck.mjs pins them to
 * the same fixtures.
 * ==========================================================================*/

const WINDOW_MS = 24 * 60 * 60 * 1000;

function parseBarTime(dt) {
  if (!dt) return null;
  const iso = dt.length <= 10 ? `${dt}T00:00:00Z` : `${dt.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** oldest-first bars {high, low}. Ambiguous intra-bar (both levels) => 'stop'. */
function classify(direction, stop, target, bars) {
  for (const b of bars) {
    const hitStop = direction === 'long' ? b.low <= stop : b.high >= stop;
    const hitTarget = direction === 'long' ? b.high >= target : b.low <= target;
    if (hitStop && hitTarget) return 'stop';
    if (hitTarget) return 'target';
    if (hitStop) return 'stop';
  }
  return 'none';
}

const body = $input.first().json;
if (!body || body.status !== 'ok' || !Array.isArray(body.values)) {
  const detail = body && body.message ? body.message : JSON.stringify(body).slice(0, 200);
  throw new Error(`Twelve Data fetch for outcome tracking failed: ${detail}`);
}

const bars = body.values
  .map((v) => ({ t: parseBarTime(v.datetime), high: parseFloat(v.high), low: parseFloat(v.low) }))
  .filter((b) => b.t !== null && Number.isFinite(b.high) && Number.isFinite(b.low))
  .sort((a, b) => a.t - b.t); // oldest-first

const oldestBar = bars.length ? bars[0].t : null;
const newestBar = bars.length ? bars[bars.length - 1].t : null;

const pending = ($('Select pending').first().json.pending) || [];

const out = [];
for (const p of pending) {
  const end = p.startMs + WINDOW_MS;

  // Row older than anything we fetched — can't score it honestly.
  if (oldestBar === null || p.startMs < oldestBar) {
    out.push({ json: { ts_utc: p.ts_utc, outcome_24h: 'no_data' }, pairedItem: { item: 0 } });
    continue;
  }
  // Window hasn't fully elapsed in the data yet — leave blank, retry tomorrow.
  if (newestBar === null || end > newestBar) continue;

  const windowBars = bars.filter((b) => b.t > p.startMs && b.t <= end);
  const outcome = windowBars.length ? classify(p.direction, p.stop, p.target, windowBars) : 'no_data';
  out.push({ json: { ts_utc: p.ts_utc, outcome_24h: outcome }, pairedItem: { item: 0 } });
}

return out;
