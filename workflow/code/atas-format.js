// Daily GC futures context, deliberately separate from the XAU/USD scorer.
const data = $input.first().json;
const fail = () => { throw new Error('ATAS summary is incomplete, stale, or invalid; nothing was posted.'); };
const number = x => typeof x === 'number' && Number.isFinite(x);
const near = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 1e-8);
if (!data || data.schemaVersion !== 1 || data.source !== 'ATAS/dxFeed' || data.symbol !== '/GC:XCEC') fail();
const { session, summary: s, quality: q } = data;
const now = Date.now(), generated = Date.parse(data.generatedAt);
if (!number(generated) || generated > now + 60000 || now - generated > 10 * 60000) fail();
if (!session || !/^\d{4}-\d{2}-\d{2}$/.test(session.date) || session.timeZone !== 'America/New_York') fail();
const start = Date.parse(session.start), end = Date.parse(session.end);
if (!number(start) || !number(end) || end - start !== 23 * 3600000 ||
    end + 15 * 60000 > now || now - end > 96 * 3600000) fail();
const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: session.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const a = parts(start), b = parts(end);
if (`${b.year}-${b.month}-${b.day}` !== session.date || a.hour !== '18' || b.hour !== '17' ||
    a.minute !== '00' || b.minute !== '00' || a.second !== '00' || b.second !== '00' ||
    [0, 6].includes(new Date(`${session.date}T12:00:00Z`).getUTCDay())) fail();
if (!q || q.complete !== true || q.barCount !== 46 || !Number.isInteger(q.priceLevelCount) || q.priceLevelCount < 1 ||
    !s || !['open', 'high', 'low', 'close', 'volume', 'poc', 'vah', 'val'].every(k => number(s[k]) && s[k] > 0) ||
    s.valueAreaPercent !== 70 || s.low > Math.min(s.open, s.close, s.val) ||
    s.high < Math.max(s.open, s.close, s.vah) || s.val > s.poc || s.poc > s.vah ||
    !number(q.unclassifiedVolume) || q.unclassifiedVolume < 0 || q.unclassifiedVolume > s.volume) fail();
if (s.delta !== null) {
  if (!number(s.delta) || !number(s.bidVolume) || !number(s.askVolume) || s.bidVolume < 0 || s.askVolume < 0 ||
      q.unclassifiedVolume !== 0 || !near(s.bidVolume + s.askVolume, s.volume) || !near(s.askVolume - s.bidVolume, s.delta)) fail();
} else if (s.bidVolume !== null || s.askVolume !== null) fail();

const state = $getWorkflowStaticData('global');
if (state.atasLastPostedSession && session.date <= state.atasLastPostedSession) return [];
const price = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const volume = n => Math.round(n).toLocaleString('en-US');
const sessionDate = session.date.split('-').reverse().join('.');
// Keep emojis outside the monospace blocks: their width differs by client.
// The compact frame fits mobile screens and mirrors the regular signal's pre.
const levelRows = [['VAH', s.vah], ['POC', s.poc], ['VAL', s.val]]
  .map(([label, value]) => `${label.padEnd(5)}${price(value).padStart(10)}`);
const innerWidth = Math.max(19, ...levelRows.map(row => row.length + 2));
const levels = [
  `┌${'─'.repeat(innerWidth)}┐`,
  ...levelRows.map(row => `│ ${row.padEnd(innerWidth - 2)} │`),
  `└${'─'.repeat(innerWidth)}┘`,
].join('\n').replace(/ /g, '\u00a0');
const prices = [['Открытие', s.open], ['Максимум', s.high], ['Минимум', s.low], ['Закрытие', s.close]]
  .map(([label, value]) => `${label.padEnd(10)}${price(value).padStart(10)}`).join('\n').replace(/ /g, '\u00a0');
const deltaIcon = s.delta === null || s.delta === 0 ? '⚪' : s.delta > 0 ? '🟢' : '🔴';
const deltaText = s.delta === null ? 'н/д · неполные данные Bid/Ask'
  : `${s.delta > 0 ? '+' : ''}${volume(s.delta)} контрактов`;
const messageHtml = [
  '🟨 <b>ЗОЛОТО · GC futures</b>',
  '<b>ATAS · ДНЕВНОЙ ОБЪЁМНЫЙ КОНТЕКСТ</b>',
  `📅 Завершённая сессия · <b>${sessionDate}</b>`,
  '',
  '🔷 <b>ПРОФИЛЬ ОБЪЁМА · 70%</b>',
  `<pre>${levels}</pre>`,
  '<i>VAH / VAL — границы зоны стоимости</i>',
  '',
  '📊 <b>ИТОГИ СЕССИИ</b>',
  `Объём · <b>${volume(s.volume)}</b> контрактов`,
  `<pre>${prices}</pre>`,
  `${deltaIcon} Дельта Ask − Bid · <b>${deltaText}</b>`,
  '',
  '🕒 18:00–17:00 Нью-Йорк · задержка 15 мин',
  '<i>ATAS/dxFeed · уровни фьючерса GC, не спот XAU/USD и не опционы.</i>',
].join('\n');
return [{ json: { sessionDate: session.date, messageHtml }, pairedItem: { item: 0 } }];
