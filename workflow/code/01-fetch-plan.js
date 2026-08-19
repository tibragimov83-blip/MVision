/* ============================================================================
 * NODE 1/5 — Build fetch plan
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Emits one item per (symbol, interval). The HTTP Request node downstream runs
 * once per item automatically, so N series cost N calls but still ONE n8n
 * execution. That is the whole reason this is a fan-out array and not a set of
 * sub-workflows.
 *
 * >>> EXTENSION SEAM <<<
 * To add an asset, add an entry to ASSETS. Nothing else in the workflow
 * changes. Check the budget first:
 *
 *   calls/day = (3 x assets + 1) x runs/day    (~48 runs/day)
 *
 *   1 asset  ->  192/day   24% of Twelve Data free tier (800/day)
 *   2 assets ->  336/day   42%
 *   3 assets ->  480/day   60%
 *   5 assets ->  768/day   96%  <- ceiling
 *   6 assets ->  912/day   exceeds free tier, needs a paid plan
 *
 * n8n executions do NOT change with asset count. The data API is the
 * binding constraint.
 * ==========================================================================*/

/* >>> LANGUAGE <<<
 * One setting, read by the Scorer (setup notes), Format message (all labels and
 * the disclaimer) and the LLM prompt (which language to write prose in).
 * Supported: 'ru', 'en'. Change it here only — nothing else needs editing.
 *
 * Prices stay in 1,234.56 format in every language. Trading channels use that
 * convention regardless of locale, and it keeps the LLM's decimal separator
 * consistent with the signal block (see the note in 05-format.js about why a
 * Russian-style comma decimal would trip the number validator).
 */
const LANG = 'ru';

const ASSETS = [
  {
    symbol: 'XAU/USD',
    label: { ru: 'ЗОЛОТО', en: 'GOLD' },
    emoji: '\u{1F7E1}', // yellow circle
    series: [
      { interval: '15min', outputsize: 100 }, // entry timing, compression
      { interval: '1h', outputsize: 200 },    // EMA 200 needs 200 bars
      { interval: '1day', outputsize: 60 },   // prior-day levels, daily ATR
    ],
  },
];

// Shared context series. Fetched once and reused by every asset, so adding a
// second asset costs 3 calls, not 4.
const CONTEXT = [
  {
    symbol: 'EUR/USD',
    interval: '1h',
    outputsize: 20,
    role: 'dollar_proxy',
  },
];

const plan = [];

for (const asset of ASSETS) {
  for (const s of asset.series) {
    plan.push({
      json: {
        role: 'asset',
        symbol: asset.symbol,
        interval: s.interval,
        outputsize: s.outputsize,
        // Resolve the display name for the active language, falling back to the
        // raw value so a plain string still works if someone edits ASSETS.
        label:
          typeof asset.label === 'string'
            ? asset.label
            : asset.label[LANG] || asset.label.en,
        emoji: asset.emoji,
        lang: LANG,
      },
      // 1:N fan-out — without pairedItem, downstream nodes that expect item
      // lineage fail with paired_item_no_info.
      pairedItem: { item: 0 },
    });
  }
}

for (const c of CONTEXT) {
  plan.push({
    json: {
      role: c.role,
      symbol: c.symbol,
      interval: c.interval,
      outputsize: c.outputsize,
      label: null,
      emoji: null,
      lang: LANG,
    },
    pairedItem: { item: 0 },
  });
}

// Fail loudly rather than posting a message built from nothing.
if (plan.length === 0) {
  throw new Error('Fetch plan is empty — check the ASSETS config array.');
}

return plan;
