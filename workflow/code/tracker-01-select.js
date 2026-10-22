/* ============================================================================
 * TRACKER 1/2 — Select pending rows
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Task 0.2 (docs/ПЛАН-РАЗВИТИЯ.md): turn the signals log into a scorecard.
 *
 * Reads every row of the `signals` sheet and keeps only the ones that still
 * need an outcome: no outcome yet, a real directional signal (so it has a stop
 * and target), and old enough that its 24h window has fully closed. Emits them
 * as ONE item carrying a `pending` array — so the Fetch node downstream makes a
 * single Twelve Data call, not one per row.
 *
 * If nothing is pending it returns [], which ends the run before the API call.
 * On a quiet day this workflow therefore costs zero Twelve Data credits.
 * ==========================================================================*/

const MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h — the outcome window must be closed

const now = Date.now();
const rows = $input.all().map((i) => i.json);

const pending = [];
for (const r of rows) {
  const scored = (r.outcome_24h ?? '').toString().trim();
  if (scored) continue; // already has an outcome

  const dir = (r.direction ?? '').toString().trim();
  if (dir !== 'long' && dir !== 'short') continue; // NO_EDGE rows have no levels

  const stop = parseFloat(r.stop);
  const target = parseFloat(r.target);
  if (!Number.isFinite(stop) || !Number.isFinite(target)) continue;

  const startMs = Date.parse(r.ts_utc); // ts_utc is ISO (…Z) from the main workflow
  if (!Number.isFinite(startMs)) continue;
  if (now - startMs < MIN_AGE_MS) continue; // window not closed yet — score it tomorrow

  pending.push({ ts_utc: r.ts_utc, direction: dir, stop, target, startMs });
}

if (pending.length === 0) return []; // nothing to do — no fetch, no API cost

return [{ json: { pending, count: pending.length, checkedAt: new Date(now).toISOString() } }];
