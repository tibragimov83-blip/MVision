/* ============================================================================
 * NODE 5/5 — Format message
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Builds the Telegram HTML message and the Google Sheets log row.
 *
 * IMPORTANT n8n BEHAVIOUR: the Basic LLM Chain node REPLACES the item json
 * with {text: "..."} — it does not pass input fields through. So the scorer's
 * data is read by node reference, and only the prose comes from $input.
 *
 * THE LLM'S LEASH. Its reply is untrusted text. Three checks before it reaches
 * a published message:
 *   1. length cap
 *   2. every number it states (above 10) must appear in the facts it was given
 *   3. HTML-escape what survives
 * Any failure -> the deterministic template is used instead. The message always
 * posts; the prose is the only thing that can degrade.
 *
 * WHY parse_mode HTML AND NOT MarkdownV2: MarkdownV2 requires escaping ~18
 * characters and returns 400 on any unescaped '.' or '-'. Both appear in every
 * price we publish.
 * ==========================================================================*/

const MAX_PROSE_CHARS = 200;
const SMALL_NUMBER_CEILING = 10; // ordinals, "1h", "20 EMA" — never a gold level

const s = $('Scorer').first().json;
const sig = s.signal;
const gate = s.eventGate || {};

const llmRaw = ($input.first().json && $input.first().json.text) || '';

/* ---------------------------------------------------------------- strings ---
 * Language comes from LANG in 01-fetch-plan.js — do not set it here.
 * This table owns the message chrome. The Scorer owns setup notes and generator
 * names, and hands them over already localised.
 *
 * Adding a language: add a block here, add one to STRINGS in 04-scorer.js, and
 * set LANG in 01-fetch-plan.js. Nothing else changes.
 */
const STRINGS = {
  ru: {
    dir: { long: 'ЛОНГ', short: 'ШОРТ' },
    conviction: 'уверенность',
    entry: 'Вход',
    stop: 'Стоп',
    target: 'Цель',
    rr: 'R:R',
    market: 'по рынку',
    // Full phrases, not an adjective plus a glued-on noun: "лондон/нью-йорк
    // сессия" is ungrammatical, and Russian adjective agreement varies by
    // session name. Any future language gets the same freedom.
    sessions: {
      asia: 'азиатская сессия',
      london: 'лондонская сессия',
      ny_overlap: 'перекрытие Лондон/Нью-Йорк',
      ny_afternoon: 'нью-йоркская сессия',
      late: 'поздняя сессия',
    },
    h24: '24ч',
    noEdge: 'НЕТ СИГНАЛА',
    standAside: 'вне рынка',
    watching: 'Наблюдаем',
    noCall: 'Направление не определено до пробоя одной из границ.',
    bestCandidate: (label, score) =>
      `Лучший кандидат — ${label}, ${score}/100. Действовать не на чем.`,
    nothingWorth: 'Сетап не сформирован. Действовать не на чем.',
    consecutive: (n) => `↻ ${n}-й запуск подряд — без изменений`,
    calendarDown: '⚠ Календарь событий недоступен — оценка с осторожностью',
    eventImminent: (title, when) => `⚠ ${title} через ${when}`,
    postEvent: (title, min) => `⚠ ${title} вышло ${min} мин назад — цена ещё не устоялась`,
    nextEvent: (when, title) => `Следующее важное событие по USD: через ${when} (${title})`,
    health: (msg) => `состояние: ${msg}`,
    healthCounts: (posted, skipped) =>
      `${posted} отправлено / ${skipped} пропущено с последней проверки`,
    disclaimer: 'Аналитический сигнал · решения принимаете самостоятельно',
    truncated: '…обрезано',
    units: { min: 'мин', h: 'ч', d: 'д' },
  },
  en: {
    dir: { long: 'LONG', short: 'SHORT' },
    conviction: 'conviction',
    entry: 'Entry',
    stop: 'Stop',
    target: 'Target',
    rr: 'R:R',
    market: 'market',
    sessions: {
      asia: 'asia session',
      london: 'london session',
      ny_overlap: 'ny overlap',
      ny_afternoon: 'ny afternoon',
      late: 'late session',
    },
    h24: '24h',
    noEdge: 'NO EDGE',
    standAside: 'stand aside',
    watching: 'Watching',
    noCall: 'No directional call until one side breaks.',
    bestCandidate: (label, score) =>
      `Best candidate was ${label} at ${score}/100. Nothing worth acting on.`,
    nothingWorth: 'No setup pattern present. Nothing worth acting on.',
    consecutive: (n) => {
      const ord = n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
      return `↻ ${ord} consecutive run — unchanged`;
    },
    calendarDown: '⚠ Event calendar unavailable — scored cautiously',
    eventImminent: (title, when) => `⚠ ${title} in ${when}`,
    postEvent: (title, min) => `⚠ ${title} printed ${min} min ago — price still settling`,
    nextEvent: (when, title) => `Next high-impact USD event: ${when} (${title})`,
    health: (msg) => `health: ${msg}`,
    healthCounts: (posted, skipped) => `${posted} posted / ${skipped} skipped since last check`,
    disclaimer: 'Analytical signal · you make your own decisions',
    truncated: '…truncated',
    units: { min: 'min', h: 'h', d: 'd' },
  },
};

// Event titles are localised by the Scorer (which owns the map, because it also
// builds the LLM facts) and arrive here already translated as eventNextLocal /
// eventLastLocal. Format just displays them.

const t = STRINGS[s.lang] || STRINGS.ru;

// ------------------------------------------------------------- validation ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Normalised numeric tokens: "2,412.30" -> "2412.30" */
function numberTokens(str) {
  const matches = String(str).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  return matches || [];
}

function validateProse(raw, factsStr) {
  const text = String(raw).trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_PROSE_CHARS) {
    return { ok: false, reason: `too long (${text.length} chars)` };
  }

  const allowed = new Set(numberTokens(factsStr));
  for (const tok of numberTokens(text)) {
    if (parseFloat(tok) <= SMALL_NUMBER_CEILING) continue; // harmless small ints
    if (!allowed.has(tok)) {
      return { ok: false, reason: `invented number "${tok}"` };
    }
  }
  return { ok: true, text };
}

/** Deterministic fallback — always available, never wrong. */
function templateProse() {
  if (sig.conviction === 'NO_EDGE') {
    return s.runnerUp
      ? t.bestCandidate(s.runnerUp.label, s.runnerUp.score)
      : t.nothingWorth;
  }
  return sig.note; // already localised by the Scorer
}

const verdict = validateProse(llmRaw, s.llmFacts);
const prose = verdict.ok ? escapeHtml(verdict.text) : templateProse();

if (!verdict.ok) {
  console.log(`LLM prose rejected (${verdict.reason}); using template. Raw: ${String(llmRaw).slice(0, 300)}`);
}

// ------------------------------------------------------------- heartbeat ----

const sd = $getWorkflowStaticData('global');
const todayUTC = s.tsUtc.slice(0, 10);

sd.dayPosted = (sd.dayPosted || 0) + 1;

let heartbeat = null;
if (sd.heartbeatDate !== todayUTC && new Date(s.tsUtc).getUTCHours() >= 8) {
  const posted = sd.dayPosted || 0;
  const skipped = sd.skipped || 0;
  heartbeat = t.healthCounts(posted, skipped);
  sd.heartbeatDate = todayUTC;
  sd.dayPosted = 0;
  sd.skipped = 0;
}

// --------------------------------------------------------------- message ----

const arrow = s.change24hPct > 0.05 ? '▲' : s.change24hPct < -0.05 ? '▼' : '▬';
// Explicit +/- with an ASCII hyphen, matching the stop/target block. (An arrow
// already shows direction, but the signed number is unambiguous on its own.)
const chg = `${s.change24hPct > 0 ? '+' : ''}${s.change24hPct}`;
const sessionLabel = t.sessions[s.session] || s.session.replace(/_/g, ' ');
// Session names are our own strings, never user input — but escape anyway so a
// future language containing & or < cannot break the HTML parse.

function fmt(n) {
  return n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const lines = [];

// Header
lines.push(`${s.emoji} <b>${escapeHtml(s.label)} · ${escapeHtml(s.symbol)}</b>   ${fmt(s.price)}`);
lines.push(
  `${arrow} ${chg}% (${t.h24}) · ${escapeHtml(sessionLabel)}`,
);
lines.push('');

// Body
if (sig.conviction === 'NO_EDGE') {
  lines.push(`<b>${t.noEdge}</b> · ${t.standAside}`);
  lines.push(prose);
} else if (sig.direction === 'none') {
  // range_squeeze and any future directionless signal: levels, never a call.
  lines.push(`<b>${escapeHtml(sig.label.toUpperCase())}</b> · ${t.conviction} ${sig.score}/100`);
  lines.push(`${t.watching}  ${fmt(sig.extras.rangeLow)} / ${fmt(sig.extras.rangeHigh)}`);
  lines.push(t.noCall);
  lines.push('');
  lines.push(prose);
} else {
  const isLong = sig.direction === 'long';
  const dir = isLong ? t.dir.long : t.dir.short;
  const tgtPct = ((Math.abs(sig.target - sig.entry) / sig.entry) * 100).toFixed(1);

  // Signs are relative to ENTRY, not to the trade's intent. On a short the stop
  // sits ABOVE entry and the target BELOW, so the signs invert. Getting this
  // backwards puts "-0.3%" next to a higher number, which reads as a typo at
  // best and as the wrong direction at worst.
  const stopSign = isLong ? '-' : '+';
  const tgtSign = isLong ? '+' : '-';

  // Pad the labels to a common width so the monospace block stays aligned in
  // any language — "Entry/Stop/Target" and "Вход/Стоп/Цель" differ in length.
  const w = Math.max(t.entry.length, t.stop.length, t.target.length) + 3;
  const pad = (label) => label + ' '.repeat(Math.max(1, w - label.length));

  lines.push(`<b>${dir}</b> · ${t.conviction} ${sig.score}/100`);
  // One <pre> block, not three inline <code> spans. Stacked <code> aligns on
  // Telegram desktop but not mobile, which pads inline code independently.
  // <pre> is the only element Telegram renders true fixed-width on every client.
  const block = [
    `${pad(t.entry)}${fmt(sig.entry)}  (${t.market})`,
    `${pad(t.stop)}${fmt(sig.stop)}  (${stopSign}${sig.stopPct}%)`,
    `${pad(t.target)}${fmt(sig.target)}  (${tgtSign}${tgtPct}%)  ·  ${t.rr} ${sig.rr}`,
  ].join('\n');
  lines.push(`<pre>${block}</pre>`);
  lines.push('');
  lines.push(prose);
}

// Repeat marker — only for a live directional signal. "Still LONG, 3rd run"
// says the setup is holding; "still no edge, 15th run" just climbs forever and
// clutters every quiet window (most 30-min windows are NO_EDGE).
if (s.consecutive > 1 && sig.direction !== 'none') {
  lines.push('');
  lines.push(`<i>${t.consecutive(s.consecutive)}</i>`);
}

// Event line. The countdown from the Event gate is language-neutral digits plus
// a unit suffix, so translate the unit here rather than re-deriving the value.
const when = gate.nextEventHuman
  ? gate.nextEventHuman
      .replace(/\bmin\b/, t.units.min)
      .replace(/(\d)h$/, `$1${t.units.h}`)
      .replace(/(\d)d$/, `$1${t.units.d}`)
  : null;

lines.push('');
const nextEventTitleLocal = s.eventNextLocal || gate.nextEventTitle;
const lastEventTitleLocal = s.eventLastLocal || gate.lastEventTitle;

if (gate.eventDataUnknown) {
  lines.push(`<i>${t.calendarDown}</i>`);
} else if (gate.minutesToNext !== null && gate.minutesToNext <= 60) {
  lines.push(`<b>${t.eventImminent(escapeHtml(nextEventTitleLocal), when)}</b>`);
} else if (gate.inPostEventWindow) {
  lines.push(`<i>${t.postEvent(escapeHtml(lastEventTitleLocal), gate.minutesSinceLast)}</i>`);
} else if (when) {
  lines.push(`<i>${t.nextEvent(when, escapeHtml(nextEventTitleLocal))}</i>`);
}

// Footer
if (heartbeat) lines.push(`<i>${t.health(heartbeat)}</i>`);
lines.push(`<i>${t.disclaimer}</i>`);

const messageHtml = lines.join('\n');

// Telegram hard-fails above 4096 characters. We run ~450, but never gamble.
const messageFinal =
  messageHtml.length > 4000 ? `${messageHtml.slice(0, 3950)}\n<i>${t.truncated}</i>` : messageHtml;

// Notify only on HIGH and MEDIUM. This is what keeps 48 messages/day tolerable:
// the channel carries everything, the phone only buzzes for something actionable.
const notified = sig.conviction === 'HIGH' || sig.conviction === 'MEDIUM';

// ---------------------------------------------------------------- output ----

return [
  {
    json: {
      // --- Telegram ---
      messageHtml: messageFinal,
      disableNotification: !notified,

      // --- Google Sheets log (column names must match the sheet header) ---
      ts_utc: s.tsUtc,
      price: s.price,
      signal_id: sig.id,
      direction: sig.direction,
      score: sig.score,
      conviction: sig.conviction,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      rr: sig.rr,
      components: JSON.stringify(sig.components),
      event_gate_min: gate.minutesToNext === null || gate.minutesToNext === undefined ? '' : gate.minutesToNext,
      session: s.session,
      consecutive: s.consecutive,
      notified: notified,
      outcome_24h: '', // filled manually in phase 1; phase-2 workflow backfills

      // --- diagnostics, not logged to the sheet ---
      _proseSource: verdict.ok ? 'llm' : `template (${verdict.reason})`,
      _candidateCount: s.candidateCount,
      _allCandidates: s.allCandidates,
      _calendarSource: gate.calendarSource,
    },
    pairedItem: { item: 0 },
  },
];
