/* ============================================================================
 * NODE 3/5 — Event gate
 * n8n Code node · Language: JavaScript · Mode: Run Once for All Items
 * ----------------------------------------------------------------------------
 * Answers one question: how close are we to a high-impact USD release?
 *
 * This is the highest-value single component in the workflow. Most retail
 * damage on gold happens in the fifteen minutes either side of a CPI, NFP or
 * FOMC print. A bot that knows to stand aside there is worth more than one
 * that knows an EMA crossed.
 *
 * WHY THE TRY/CATCH MATTERS: a Code node has no retryOnFail. An unhandled
 * throw here kills the whole run and the channel goes silent. So a calendar
 * outage degrades instead of failing:
 *     fresh cache  -> use it
 *     stale cache  -> use it, flag staleness
 *     no cache     -> eventDataUnknown = true, scorer applies a precautionary
 *                     penalty rather than assuming the coast is clear
 *
 * KNOWN LIMITATION: the feed covers the current FF week (Sunday–Saturday).
 * A Friday run cannot see the following Monday's events. Since the gate only
 * reacts inside a 120-minute window, that gap is harmless.
 * ==========================================================================*/

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MIN = 360;   // 6 hours -> ~4 fetches/day
const POST_EVENT_WINDOW = 15; // minutes after a print where price is still noise

const ctx = $input.first().json;
const sd = $getWorkflowStaticData('global');
const nowMs = Date.now();

// ------------------------------------------------------ cache read / fetch ---

let events = Array.isArray(sd.calendarEvents) ? sd.calendarEvents : null;
const fetchedAt = sd.calendarFetchedAt ? Date.parse(sd.calendarFetchedAt) : 0;
const cacheAgeMin = fetchedAt ? (nowMs - fetchedAt) / 60000 : Infinity;

let eventDataUnknown = false;
let calendarStale = false;
let calendarSource = 'cache';

if (!events || cacheAgeMin > CACHE_TTL_MIN) {
  try {
    // NOTE: this.helpers.httpRequest — NOT $helpers, which is undefined in the
    // n8n 2.x task-runner sandbox and throws ReferenceError.
    const res = await this.helpers.httpRequest({
      method: 'GET',
      url: CALENDAR_URL,
      json: true,
      timeout: 10000,
    });

    // The endpoint serves a bare JSON array, sometimes as text/plain.
    const parsed = typeof res === 'string' ? JSON.parse(res) : res;
    if (!Array.isArray(parsed)) throw new Error('Calendar payload was not an array');

    events = parsed
      .filter((e) => e && e.country === 'USD' && e.impact === 'High')
      .map((e) => ({
        title: String(e.title || 'Unnamed event'),
        // FF dates carry a US-Eastern offset, so Date.parse handles the zone.
        ts: Date.parse(e.date),
      }))
      .filter((e) => Number.isFinite(e.ts))
      .sort((a, b) => a.ts - b.ts);

    sd.calendarEvents = events;
    sd.calendarFetchedAt = new Date(nowMs).toISOString();
    calendarSource = 'fetched';
    console.log(`Calendar refreshed: ${events.length} high-impact USD events this week.`);
  } catch (err) {
    // Degrade, never die.
    if (Array.isArray(sd.calendarEvents) && sd.calendarEvents.length > 0) {
      events = sd.calendarEvents;
      calendarStale = true;
      calendarSource = 'stale_cache';
      console.log(`Calendar fetch failed (${err.message}); using cache from ${sd.calendarFetchedAt}.`);
    } else {
      events = [];
      eventDataUnknown = true;
      calendarSource = 'unavailable';
      console.log(`Calendar fetch failed (${err.message}) and no cache exists; assuming event risk.`);
    }
  }
}

// -------------------------------------------------------------- proximity ---

let minutesToNext = null;
let nextEventTitle = null;
let nextEventTsUtc = null;

const upcoming = events.filter((e) => e.ts > nowMs);
if (upcoming.length > 0) {
  const next = upcoming[0];
  minutesToNext = Math.round((next.ts - nowMs) / 60000);
  nextEventTitle = next.title;
  nextEventTsUtc = new Date(next.ts).toISOString();
}

// Did something just print? Price is unreliable for a few minutes afterwards.
let minutesSinceLast = null;
let lastEventTitle = null;
const past = events.filter((e) => e.ts <= nowMs);
if (past.length > 0) {
  const last = past[past.length - 1];
  minutesSinceLast = Math.round((nowMs - last.ts) / 60000);
  lastEventTitle = last.title;
}
const inPostEventWindow =
  minutesSinceLast !== null && minutesSinceLast <= POST_EVENT_WINDOW;

/** Human-readable countdown for the message footer. */
function humanise(min) {
  if (min === null) return null;
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (60 * 24))}d`;
}

return [
  {
    json: {
      ...ctx,
      eventGate: {
        minutesToNext,
        nextEventTitle,
        nextEventTsUtc,
        nextEventHuman: humanise(minutesToNext),
        minutesSinceLast,
        lastEventTitle,
        inPostEventWindow,
        eventDataUnknown,
        calendarStale,
        calendarSource,
        eventCount: events.length,
      },
    },
    pairedItem: { item: 0 },
  },
];
