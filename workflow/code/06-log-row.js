/* ============================================================================
 * NODE 6/6 — Log row
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Sits between Format message and Log to Sheets, and emits ONLY the 16 columns
 * the sheet is designed to hold.
 *
 * WHY THIS NODE EXISTS: the Google Sheets node's "Map Automatically" mode does
 * not ignore input fields that have no matching header — it CREATES a column
 * for each one. Wiring Format message straight into it added six unwanted
 * columns (messageHtml, disableNotification and the four _diagnostics), putting
 * a 500-character HTML blob in every row and letting the sheet schema be
 * decided by whatever happened to be on the item.
 *
 * The schema is a design decision, not an emergent property. This node is the
 * one place that decides it.
 *
 * The diagnostics are still visible on the Format message node in the n8n UI
 * for debugging. To log one deliberately — _proseSource is the useful one, since
 * it tells you how often the LLM's prose is being rejected — add the header to
 * the sheet AND add the field to COLUMNS below. Both, in that order.
 * ==========================================================================*/

const COLUMNS = [
  'ts_utc',
  'price',
  'signal_id',
  'direction',
  'score',
  'conviction',
  'entry',
  'stop',
  'target',
  'rr',
  'components',
  'event_gate_min',
  'session',
  'consecutive',
  'notified',
  'outcome_24h',
];

const src = $input.first().json;

const row = {};
for (const col of COLUMNS) {
  const v = src[col];
  // Blank out null/undefined so the cell is empty rather than reading "null".
  // Note `??` deliberately preserves false and 0, which are real values here
  // (notified can be false, and event_gate_min or score can legitimately be 0).
  row[col] = v ?? '';
}

return [{ json: row, pairedItem: { item: 0 } }];
