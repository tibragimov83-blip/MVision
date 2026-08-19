/* ============================================================================
 * NODE 4/5 — Scorer
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Deterministic. Given the same indicators it always produces the same winner.
 * The LLM downstream never sees this logic and cannot alter a single number.
 *
 * >>> EXTENSION SEAM <<<
 * Add a signal by appending to GENERATORS. A generator returns null when its
 * pattern is absent, or a candidate object. Everything after that — scoring,
 * stops, targets, banding — is shared and needs no change.
 *
 * >>> CALIBRATION KNOB <<<
 * WEIGHTS below is a v1 hypothesis, not a validated model. Nobody can tell you
 * the right number for "dollar agrees" without data. The Google Sheets log
 * records which terms fired on every run; after ~2-3 weeks reweight against
 * observed outcomes. Treat these as a starting point.
 * ==========================================================================*/

const WEIGHTS = {
  emaAgrees: 15,
  dollarAgrees: 12,
  volatilityFits: 10,
  sessionFits: 8,
  goodRR: 10,
  eventWithin60: -40,
  eventWithin120: -20,
  dailyConflict: -12,
  breakoutInAsia: -10,
};

const BANDS = { high: 70, medium: 50, low: 30 };

const STOP_FLOOR_PCT = 0.0030; // 0.30% — ~7 pts at 2,400
const STOP_CEIL_PCT = 0.0080;  // 0.80% — ~19 pts at 2,400
const STOP_BUFFER_ATR = 0.15;  // how far past the structural level the stop sits
const MIN_TARGET_R = 1.2;      // a level closer than this isn't worth targeting
const MAX_TARGET_R = 4.0;      // ...and one further than this is a SWING target
const DEFAULT_TARGET_R = 2.0;  // fallback when no level is in range

const c = $input.first().json;
const gate = c.eventGate || {};

/* ---------------------------------------------------------------- strings ---
 * Language comes from LANG in 01-fetch-plan.js — do not set it here.
 * These are the strings this node produces: generator display names, the setup
 * notes, and the language name handed to the LLM prompt.
 * Format message owns the message chrome and has its own table.
 */
const STRINGS = {
  ru: {
    langName: 'Russian (русский)',
    noSetup: 'Сетап не сформирован.',
    // ForexFactory event titles arrive in English. Unmapped titles fall through
    // unchanged — the acronyms (FOMC, CPI, NFP, PMI) are used untranslated by
    // Russian traders anyway, so an unknown event still reads sensibly.
    // Lives here rather than in Format because the LLM facts (built below) must
    // carry the localised name too, or the prose and the chrome disagree.
    eventNames: {
      'FOMC Meeting Minutes': 'протокол FOMC',
      'FOMC Statement': 'решение FOMC',
      'FOMC Press Conference': 'пресс-конференция FOMC',
      'Federal Funds Rate': 'ставка ФРС',
      'CPI m/m': 'ИПЦ м/м',
      'CPI y/y': 'ИПЦ г/г',
      'Core CPI m/m': 'базовый ИПЦ м/м',
      'Core PCE Price Index m/m': 'базовый PCE м/м',
      'PPI m/m': 'ИЦП м/м',
      'Core PPI m/m': 'базовый ИЦП м/м',
      'Non-Farm Employment Change': 'занятость вне с/х (NFP)',
      'ADP Non-Farm Employment Change': 'занятость ADP',
      'Unemployment Rate': 'уровень безработицы',
      'Average Hourly Earnings m/m': 'средняя зарплата м/м',
      'Unemployment Claims': 'заявки на пособие',
      'JOLTS Job Openings': 'вакансии JOLTS',
      'ISM Manufacturing PMI': 'PMI ISM (промышленность)',
      'ISM Services PMI': 'PMI ISM (услуги)',
      'Flash Manufacturing PMI': 'предв. PMI (промышленность)',
      'Flash Services PMI': 'предв. PMI (услуги)',
      'Retail Sales m/m': 'розничные продажи м/м',
      'Core Retail Sales m/m': 'базовые розничные продажи м/м',
      'Advance GDP q/q': 'предв. ВВП кв/кв',
      'Prelim GDP q/q': 'предв. ВВП кв/кв',
      'Final GDP q/q': 'итог. ВВП кв/кв',
      'Fed Chair Powell Speaks': 'выступление Пауэлла',
      'Fed Chair Powell Testifies': 'выступление Пауэлла в Конгрессе',
      'Prelim UoM Consumer Sentiment': 'предв. индекс Мичигана',
      'Consumer Confidence': 'индекс доверия потребителей',
      'Durable Goods Orders m/m': 'заказы на товары длит. пользования м/м',
      'Crude Oil Inventories': 'запасы нефти',
      'Treasury Currency Report': 'валютный отчёт Минфина',
    },
    labels: {
      pdh_pdl_break: 'пробой вчерашнего уровня',
      liquidity_sweep: 'съём ликвидности',
      trend_continuation: 'продолжение тренда',
      session_open_break: 'пробой открытия сессии',
      mean_reversion: 'возврат к средней',
      range_squeeze: 'сжатие диапазона',
      none: 'нет кандидата',
    },
    sessionNames: {
      asia: 'азиатской',
      london: 'лондонской',
      ny_overlap: 'лондон/нью-йорк',
      ny_afternoon: 'нью-йоркской',
      late: 'поздней',
    },
    notes: {
      break: (up, level) =>
        `Пробой вчерашнего ${up ? 'максимума' : 'минимума'} на ${level} с удержанием.`,
      sweep: (up) =>
        `Прокол вчерашнего ${up ? 'максимума' : 'минимума'} с возвратом внутрь диапазона.`,
      trendUp: (lvl) => `Тренд 1ч вверх, цена удержала 20 EMA на ${lvl}.`,
      trendDown: (lvl) => `Тренд 1ч вниз, цена отбилась от 20 EMA на ${lvl}.`,
      sessionBreak: (session, up, lvl) =>
        `Пробой ${session} сессии: ${up ? 'максимум' : 'минимум'} первого часа на ${lvl}.`,
      stretch: (atr, above) =>
        `Отклонение ${atr} ATR ${above ? 'выше' : 'ниже'} 20 EMA — риск возврата.`,
      squeeze: (range, ratio, lo, hi) =>
        `Сжатие в диапазоне ${range} (${ratio} ATR) — направление не определено до пробоя ${lo}/${hi}.`,
    },
  },
  en: {
    langName: 'English',
    noSetup: 'No setup pattern present.',
    eventNames: {}, // already English — pass through unchanged
    labels: {
      pdh_pdl_break: 'prior-day break',
      liquidity_sweep: 'liquidity sweep',
      trend_continuation: 'trend continuation',
      session_open_break: 'session open break',
      mean_reversion: 'mean reversion',
      range_squeeze: 'range squeeze',
      none: 'no candidate',
    },
    sessionNames: {
      asia: 'Asia',
      london: 'London',
      ny_overlap: 'London/NY',
      ny_afternoon: 'New York',
      late: 'late',
    },
    notes: {
      break: (up, level) =>
        `${up ? 'Broke above' : 'Broke below'} yesterday's ${up ? 'high' : 'low'} at ${level} and held.`,
      sweep: (up) =>
        `Wicked ${up ? 'above' : 'below'} yesterday's ${up ? 'high' : 'low'} and closed back inside.`,
      trendUp: (lvl) => `1h trend up, price held the 20 EMA at ${lvl}.`,
      trendDown: (lvl) => `1h trend down, price rejected the 20 EMA at ${lvl}.`,
      sessionBreak: (session, up, lvl) =>
        `Broke the ${session} opening range ${up ? 'high' : 'low'} at ${lvl}.`,
      stretch: (atr, above) =>
        `Stretched ${atr} ATR ${above ? 'above' : 'below'} the 20 EMA — snapback risk.`,
      squeeze: (range, ratio, lo, hi) =>
        `Compressed into a ${range} range (${ratio} ATR) — direction unresolved until ${lo}/${hi} breaks.`,
    },
  },
};

const t = STRINGS[c.lang] || STRINGS.ru;

/** Localise a ForexFactory event title, or return it unchanged if unmapped. */
function eventName(title) {
  if (!title) return title;
  return (t.eventNames && t.eventNames[title]) || title;
}
const eventNextLocal = eventName(gate.nextEventTitle);
const eventLastLocal = eventName(gate.lastEventTitle);

// ------------------------------------------------------------- generators ---
// Order matters only for tie-breaking (earlier wins an exact tie).

const GENERATORS = [
  {
    id: 'pdh_pdl_break',
    label: t.labels.pdh_pdl_break,
    signalType: 'breakout',
    generate: (x) => {
      if (!x.prev15) return null;
      const brokeUp =
        x.prev15.close > x.priorDayHigh && x.last15.close > x.priorDayHigh;
      const brokeDown =
        x.prev15.close < x.priorDayLow && x.last15.close < x.priorDayLow;
      if (!brokeUp && !brokeDown) return null;

      const direction = brokeUp ? 'long' : 'short';
      const level = brokeUp ? x.priorDayHigh : x.priorDayLow;
      // Already extended well past the level = chasing, so score it lower.
      const extension = Math.abs(x.price - level) / x.atr1h;
      return {
        direction,
        base: extension > 1.5 ? 40 : 48,
        structuralLevel: level,
        note: t.notes.break(brokeUp, level),
        extension: Math.round(extension * 100) / 100,
      };
    },
  },

  {
    id: 'liquidity_sweep',
    label: t.labels.liquidity_sweep,
    signalType: 'reversal',
    generate: (x) => {
      const sweptHigh =
        x.last15.high > x.priorDayHigh && x.last15.close < x.priorDayHigh;
      const sweptLow =
        x.last15.low < x.priorDayLow && x.last15.close > x.priorDayLow;
      if (!sweptHigh && !sweptLow) return null;

      return {
        direction: sweptHigh ? 'short' : 'long',
        base: 45,
        structuralLevel: sweptHigh ? x.last15.high : x.last15.low,
        note: t.notes.sweep(sweptHigh),
      };
    },
  },

  {
    id: 'trend_continuation',
    label: t.labels.trend_continuation,
    signalType: 'continuation',
    generate: (x) => {
      if (x.emaStack === 0 || x.ema20 === null) return null;
      const dist = (x.price - x.ema20) / x.atr1h;

      // Long: pulled back toward EMA20 from above and holding.
      if (x.emaStack === 1 && dist >= -0.2 && dist <= 0.8) {
        return {
          direction: 'long',
          base: Math.abs(dist) < 0.3 ? 42 : 35,
          structuralLevel: x.ema20,
          note: t.notes.trendUp(x.ema20),
        };
      }
      // Short: mirror.
      if (x.emaStack === -1 && dist <= 0.2 && dist >= -0.8) {
        return {
          direction: 'short',
          base: Math.abs(dist) < 0.3 ? 42 : 35,
          structuralLevel: x.ema20,
          note: t.notes.trendDown(x.ema20),
        };
      }
      return null;
    },
  },

  {
    id: 'session_open_break',
    label: t.labels.session_open_break,
    signalType: 'breakout',
    generate: (x) => {
      if (x.firstHourHigh === null || x.firstHourLow === null) return null;
      // Meaningless while still inside the first hour of the session.
      if (x.hourUTC <= x.sessionStartHour) return null;
      if (x.session !== 'london' && x.session !== 'ny_overlap') return null;

      const sessionName = t.sessionNames[x.session] || x.session;
      if (x.price > x.firstHourHigh) {
        return {
          direction: 'long',
          base: 40,
          structuralLevel: x.firstHourHigh,
          note: t.notes.sessionBreak(sessionName, true, x.firstHourHigh),
        };
      }
      if (x.price < x.firstHourLow) {
        return {
          direction: 'short',
          base: 40,
          structuralLevel: x.firstHourLow,
          note: t.notes.sessionBreak(sessionName, false, x.firstHourLow),
        };
      }
      return null;
    },
  },

  {
    id: 'mean_reversion',
    label: t.labels.mean_reversion,
    signalType: 'reversion',
    generate: (x) => {
      if (x.ema20 === null) return null;
      const stretch = (x.price - x.ema20) / x.atr1h;
      if (Math.abs(stretch) < 2.0) return null;

      const direction = stretch > 0 ? 'short' : 'long';
      return {
        direction,
        base: Math.abs(stretch) > 2.5 ? 42 : 38,
        structuralLevel: direction === 'short' ? x.last15.high : x.last15.low,
        note: t.notes.stretch(Math.abs(stretch).toFixed(1), stretch > 0),
        stretch: Math.round(stretch * 100) / 100,
      };
    },
  },

  {
    id: 'range_squeeze',
    label: t.labels.range_squeeze,
    signalType: 'compression',
    // Directionless by construction: compression says a move is coming, not
    // which way. Capped at LOW downstream so it can never publish a
    // directional call without an invalidation level.
    generate: (x) => {
      if (x.compressionRatio >= 0.6) return null;
      return {
        direction: 'none',
        base: 35,
        structuralLevel: null,
        note: t.notes.squeeze(x.range8, x.compressionRatio, x.range8Low, x.range8High),
        rangeHigh: x.range8High,
        rangeLow: x.range8Low,
      };
    },
  },
];

// ------------------------------------------------------- stop and target ----

function buildLevels(cand, x) {
  if (cand.direction === 'none' || cand.structuralLevel === null) {
    return { entry: x.price, stop: null, target: null, rr: null, stopPct: null };
  }

  const entry = x.price;
  const isLong = cand.direction === 'long';

  const rawStop = isLong
    ? cand.structuralLevel - STOP_BUFFER_ATR * x.atr1h
    : cand.structuralLevel + STOP_BUFFER_ATR * x.atr1h;

  // Clamp the DISTANCE, not the level, so the published stop always sits
  // inside the 0.30%–0.80% band the spec requires.
  const rawDist = Math.abs(entry - rawStop);
  const dist = Math.min(
    Math.max(rawDist, STOP_FLOOR_PCT * entry),
    STOP_CEIL_PCT * entry,
  );
  const stop = isLong ? entry - dist : entry + dist;

  // Nearest opposing structural level that is far enough to be worth targeting
  // but close enough to still be an INTRADAY target.
  //
  // The upper bound matters more than it looks. Without it, a swing-scale level
  // (a 20-bar 1h swing high can sit 3-4% away) becomes the target of a signal
  // whose stop is 0.5% — producing a published R:R of 7, which is not a real
  // edge, it is a horizon mismatch. Worse, that fake ratio then earns the
  // goodRR bonus and inflates the score. Beyond MAX_TARGET_R we ignore the
  // level and fall back to a plain 2R, which is honest for a 1-12h hold.
  const candidates = isLong
    ? [x.priorDayHigh, x.swingHigh, x.sessionHigh]
    : [x.priorDayLow, x.swingLow, x.sessionLow];

  const viable = candidates
    .filter((lvl) => Number.isFinite(lvl))
    .filter((lvl) => (isLong ? lvl > entry : lvl < entry))
    .filter((lvl) => Math.abs(lvl - entry) >= MIN_TARGET_R * dist)
    .filter((lvl) => Math.abs(lvl - entry) <= MAX_TARGET_R * dist)
    .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));

  const target =
    viable.length > 0
      ? viable[0]
      : isLong
        ? entry + DEFAULT_TARGET_R * dist
        : entry - DEFAULT_TARGET_R * dist;

  return {
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    rr: Math.round((Math.abs(target - entry) / dist) * 100) / 100,
    stopPct: Math.round((dist / entry) * 1000) / 10, // e.g. 0.6 meaning 0.6%
  };
}

// --------------------------------------------------------------- scoring ----

const VOL_FIT = {
  breakout: (atrPct) => atrPct >= 0.12,
  continuation: (atrPct) => atrPct >= 0.10,
  reversion: (atrPct) => atrPct >= 0.15,
  reversal: (atrPct) => atrPct >= 0.12,
  compression: (atrPct) => atrPct <= 0.20,
};

const SESSION_FIT = {
  breakout: ['london', 'ny_overlap'],
  continuation: ['london', 'ny_overlap', 'ny_afternoon'],
  reversion: ['asia', 'ny_afternoon', 'late'],
  reversal: ['london', 'ny_overlap', 'ny_afternoon'],
  compression: ['asia', 'late'],
};

function score(cand, gen, x, levels) {
  const components = {};
  let total = cand.base;
  components.base = cand.base;

  const dirSign = cand.direction === 'long' ? 1 : cand.direction === 'short' ? -1 : 0;

  // + 1h EMA stack agrees
  if (dirSign !== 0 && x.emaStack === dirSign) {
    total += WEIGHTS.emaAgrees;
    components.emaAgrees = WEIGHTS.emaAgrees;
  }

  // + dollar direction supports the trade (EUR/USD up => dollar down => gold up)
  if (dirSign !== 0 && x.dollarDir === dirSign) {
    total += WEIGHTS.dollarAgrees;
    components.dollarAgrees = WEIGHTS.dollarAgrees;
  }

  // + volatility regime suits this kind of signal
  const volFn = VOL_FIT[gen.signalType];
  if (volFn && volFn(x.atrPctOfPrice)) {
    total += WEIGHTS.volatilityFits;
    components.volatilityFits = WEIGHTS.volatilityFits;
  }

  // + session suits this kind of signal
  if ((SESSION_FIT[gen.signalType] || []).includes(x.session)) {
    total += WEIGHTS.sessionFits;
    components.sessionFits = WEIGHTS.sessionFits;
  }

  // + reward:risk is worth taking
  if (levels.rr !== null && levels.rr >= 2) {
    total += WEIGHTS.goodRR;
    components.goodRR = WEIGHTS.goodRR;
  }

  // - event risk. Unknown calendar data is treated as the 120-minute case:
  //   assume risk rather than assume safety.
  const m = gate.minutesToNext;
  if (gate.eventDataUnknown) {
    total += WEIGHTS.eventWithin120;
    components.eventDataUnknown = WEIGHTS.eventWithin120;
  } else if (m !== null && m !== undefined) {
    if (m <= 60) {
      total += WEIGHTS.eventWithin60;
      components.eventWithin60 = WEIGHTS.eventWithin60;
    } else if (m <= 120) {
      total += WEIGHTS.eventWithin120;
      components.eventWithin120 = WEIGHTS.eventWithin120;
    }
  }

  // OPTIONAL 10th TERM, deliberately not enabled: a penalty for the ~15 min
  // after a print, when price is still noise. `gate.inPostEventWindow` carries
  // the flag and the message annotates it, but it does not affect the score,
  // because the approved spec defines exactly nine terms. Enable by
  // uncommenting — and log the change, so the Sheets history stays comparable.
  // if (gate.inPostEventWindow) { total -= 15; components.postEvent = -15; }

  // - daily trend disagrees with the trade
  if (dirSign !== 0 && x.dailyTrend !== 0 && x.dailyTrend !== dirSign) {
    total += WEIGHTS.dailyConflict;
    components.dailyConflict = WEIGHTS.dailyConflict;
  }

  // - breakouts during the Asia session are usually noise
  if (gen.signalType === 'breakout' && x.session === 'asia') {
    total += WEIGHTS.breakoutInAsia;
    components.breakoutInAsia = WEIGHTS.breakoutInAsia;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(total))),
    components,
  };
}

// -------------------------------------------------------------- evaluate ----

const evaluated = [];

for (let i = 0; i < GENERATORS.length; i++) {
  const gen = GENERATORS[i];
  let cand;
  try {
    cand = gen.generate(c);
  } catch (err) {
    // A broken generator must not take the whole run down with it.
    console.log(`Generator ${gen.id} threw: ${err.message}`);
    continue;
  }
  if (!cand) continue;

  const levels = buildLevels(cand, c);
  const { score: sc, components } = score(cand, gen, c, levels);

  evaluated.push({
    id: gen.id,
    label: gen.label,
    signalType: gen.signalType,
    order: i,
    direction: cand.direction,
    score: sc,
    components,
    note: cand.note,
    structuralLevel: cand.structuralLevel,
    ...levels,
    extras: {
      extension: cand.extension ?? null,
      stretch: cand.stretch ?? null,
      rangeHigh: cand.rangeHigh ?? null,
      rangeLow: cand.rangeLow ?? null,
    },
  });
}

// Highest score wins. Ties -> higher R:R, then earlier generator order.
evaluated.sort((a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  const arr = a.rr === null ? -1 : a.rr;
  const brr = b.rr === null ? -1 : b.rr;
  if (brr !== arr) return brr - arr;
  return a.order - b.order;
});

const winner = evaluated.length > 0 ? evaluated[0] : null;

// ------------------------------------------------------------- banding -----

function bandFor(w) {
  if (!w || w.score < BANDS.low) return 'NO_EDGE';
  if (w.score >= BANDS.high) return 'HIGH';
  if (w.score >= BANDS.medium) return 'MEDIUM';
  return 'LOW';
}

let conviction = bandFor(winner);

// A directionless signal never claims a direction, so it can never publish as
// an actionable HIGH/MEDIUM call. Cap at LOW.
if (winner && winner.direction === 'none' && conviction !== 'NO_EDGE') {
  conviction = 'LOW';
}

// ------------------------------------------------------ repeat detection ----

const sd = $getWorkflowStaticData('global');
const signature = winner ? `${winner.id}|${winner.direction}` : 'none|none';

if (sd.lastSignal === signature) {
  sd.consecutiveCount = (sd.consecutiveCount || 1) + 1;
} else {
  sd.consecutiveCount = 1;
  sd.lastSignal = signature;
}
const consecutive = sd.consecutiveCount;

// ---------------------------------------------------------------- output ----

// Runner-up context, for the NO_EDGE message and for post-hoc analysis.
const runnerUp = evaluated.length > 1 ? evaluated[1] : null;

/**
 * Facts handed to the LLM. Built here because this node owns every number in
 * it; the LLM node's own config then stays a one-line expression.
 *
 * This string is ALSO the whitelist the Format node validates the LLM's reply
 * against — any number in the reply that is not in here (and is above 10) gets
 * the reply discarded in favour of the template. So do not trim it below the
 * set of numbers the prose is legitimately allowed to mention.
 */
function buildFacts(w, band) {
  const lines = [
    `asset: ${c.label} (${c.symbol})`,
    `price: ${c.price}`,
    `24h change: ${c.change24hPct}%`,
    `session: ${c.session.replace('_', ' ')}`,
    `1h trend: ${c.emaStack === 1 ? 'up' : c.emaStack === -1 ? 'down' : 'mixed'}`,
    `20 EMA: ${c.ema20}`,
    `dollar: ${c.dollarDir === 1 ? 'softening' : c.dollarDir === -1 ? 'firming' : 'flat'}`,
    `prior day high: ${c.priorDayHigh}`,
    `prior day low: ${c.priorDayLow}`,
    `setup: ${w ? w.label : 'none'}`,
    `direction: ${w ? w.direction : 'none'}`,
    `conviction: ${band} (${w ? w.score : 0} of 100)`,
    `observation: ${w ? w.note : 'No setup pattern present.'}`,
  ];
  if (w && w.entry !== null && w.stop !== null) {
    lines.push(`entry: ${w.entry}`, `stop: ${w.stop}`, `target: ${w.target}`, `risk reward: ${w.rr}`);
  }
  if (gate.minutesToNext !== null && gate.minutesToNext !== undefined) {
    // Localised name so the prose matches the message chrome instead of echoing
    // the raw English title into a Russian sentence.
    lines.push(`next high-impact USD event: ${eventNextLocal} in ${gate.nextEventHuman}`);
  }
  return lines.join('\n');
}
// The facts stay in English regardless of output language: they are machine
// input, the LLM reads them fine, and keeping them stable means the Format
// node's number whitelist is unaffected by a language change.

return [
  {
    json: {
      ...c,
      signal: winner
        ? {
            id: winner.id,
            label: winner.label,
            signalType: winner.signalType,
            direction: winner.direction,
            score: winner.score,
            conviction,
            entry: winner.entry,
            stop: winner.stop,
            target: winner.target,
            rr: winner.rr,
            stopPct: winner.stopPct,
            note: winner.note,
            components: winner.components,
            extras: winner.extras,
          }
        : {
            id: 'none',
            label: t.labels.none,
            signalType: null,
            direction: 'none',
            score: 0,
            conviction: 'NO_EDGE',
            entry: c.price,
            stop: null,
            target: null,
            rr: null,
            stopPct: null,
            note: t.noSetup,
            components: {},
            extras: {},
          },
      llmFacts: buildFacts(winner, conviction),
      // Consumed by the LLM prompt in build.mjs, so the language setting has a
      // single home in 01-fetch-plan.js rather than being duplicated there.
      langName: t.langName,
      // Localised event titles for Format's chrome — same source as the facts,
      // so prose and chrome always agree.
      eventNextLocal,
      eventLastLocal,
      consecutive,
      candidateCount: evaluated.length,
      runnerUp: runnerUp
        ? { id: runnerUp.id, label: runnerUp.label, score: runnerUp.score }
        : null,
      allCandidates: evaluated.map((e) => ({
        id: e.id,
        direction: e.direction,
        score: e.score,
      })),
    },
    pairedItem: { item: 0 },
  },
];
