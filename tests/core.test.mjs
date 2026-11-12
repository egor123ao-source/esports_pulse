import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarEvent,
  createRequestGate,
  dateRange,
  escapeHTML,
  filterMatches,
  isFollowed,
  matchKind,
  newsMatchesGame,
  normalizeTeams,
  safeURL,
  toggleTeam,
  uniqueMatches,
} from '../app-core.js';

const localTime = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month - 1, day, hour, minute, second, ms);

test('dateRange uses local calendar boundaries across months and leap days', () => {
  const now = localTime(2028, 2, 29, 18, 45);
  const cases = [
    ['today', 'up', localTime(2028, 2, 29), localTime(2028, 2, 29, 23, 59, 59, 999)],
    ['tomorrow', 'up', localTime(2028, 3, 1), localTime(2028, 3, 1, 23, 59, 59, 999)],
    ['yesterday', 'past', localTime(2028, 2, 28), localTime(2028, 2, 28, 23, 59, 59, 999)],
    ['week', 'up', localTime(2028, 2, 29), localTime(2028, 3, 6, 23, 59, 59, 999)],
    ['week', 'past', localTime(2028, 2, 23), localTime(2028, 2, 29, 23, 59, 59, 999)],
  ];
  for (const [period, tab, from, to] of cases) {
    assert.deepEqual(dateRange(period, tab, now), { from: from.toISOString(), to: to.toISOString() }, `${period}/${tab}`);
  }
  assert.deepEqual(dateRange('all', 'past', now), {});
  assert.equal(now.getHours(), 18, 'the caller’s Date must not be mutated');
});

const matches = [
  { id: 1, a: 'Team Spirit', b: 'Falcons', event: 'World Finals', game: 'CS2', slug: 'csgo', t: '2026-11-11T10:00:00Z' },
  { id: 2, a: 'Team Spirit', b: 'Liquid', event: 'World Finals', game: 'Dota 2', slug: 'dota2', t: '2026-11-11T11:00:00Z' },
  { id: 3, a: 'Team Spirit', b: 'Falcons', event: 'Regional Cup', game: 'CS2', slug: 'csgo', t: '2026-11-12T10:00:00Z' },
  { id: 4, a: 'Team Spirit', b: 'Falcons', event: 'World Finals', game: 'CS2', slug: 'csgo', t: 'not-a-date' },
];

test('filterMatches combines game and all search words regardless of case/order', () => {
  const filtered = filterMatches(matches, { game: 'csgo', query: '  FINALS   spirit  ' });
  assert.deepEqual(filtered.map(match => match.id), [1, 4]);
  assert.deepEqual(filterMatches(matches, { query: 'Liquid Dota' }).map(match => match.id), [2]);
  assert.deepEqual(filterMatches(matches, { game: 'valorant' }), []);
  assert.equal(filterMatches(matches).length, matches.length);
  assert.deepEqual(matches.map(match => match.id), [1, 2, 3, 4], 'filter must not change the source');
});

test('filterMatches treats time boundaries as inclusive and excludes invalid match dates', () => {
  const from = '2026-11-11T10:00:00Z';
  const to = '2026-11-11T11:00:00Z';
  assert.deepEqual(filterMatches(matches, { from, to }).map(match => match.id), [1, 2]);
  assert.deepEqual(filterMatches(matches, { game: 'csgo', from, to }).map(match => match.id), [1]);
  assert.deepEqual(filterMatches(matches, { from: '2026-11-11T10:00:00.001Z', to }).map(match => match.id), [2]);
  assert.deepEqual(filterMatches(matches, { to: '2026-11-11T09:59:59Z' }), []);
  assert.deepEqual(filterMatches(matches, { from: '2026-11-12T10:00:00Z' }).map(match => match.id), [3]);
});

test('match statuses and page merging preserve live and updated scores', () => {
  assert.equal(matchKind({ status: 'running' }), 'live');
  assert.equal(matchKind({ status: 'finished' }), 'past');
  assert.equal(matchKind({ status: 'not_started' }), 'up');
  assert.equal(matchKind({ status: 'postponed' }), 'postponed');
  assert.equal(matchKind({ status: 'canceled' }), 'canceled');
  assert.equal(matchKind({ win: 'Spirit' }), 'past');
  const result = uniqueMatches([{ id: 1, x: 0 }, { id: 2, x: 1 }, { id: '1', x: 2 }]);
  assert.equal(result.length, 2);
  assert.equal(result.find(match => String(match.id) === '1').x, 2);
});

test('request gate aborts stale requests while leaving independent sections current', async () => {
  const gate = createRequestGate();
  const first = gate.begin('players');
  const news = gate.begin('news');
  let aborted = false;
  first.signal.addEventListener('abort', () => { aborted = true; });
  const second = gate.begin('players');
  assert.equal(aborted, true);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
  assert.equal(news.current(), true);
  const accepted = [];
  await Promise.all([
    Promise.resolve('old').then(value => { if (first.current()) accepted.push(value); }),
    Promise.resolve('new').then(value => { if (second.current()) accepted.push(value); }),
  ]);
  assert.deepEqual(accepted, ['new']);
  gate.cancel('players');
  assert.equal(second.signal.aborted, true);
  assert.equal(second.current(), false);
  assert.equal(news.current(), true);
  gate.cancel('unknown');
  assert.equal(gate.begin('players').current(), true);
});

test('favorites migrate legacy names, remove invalid values, and keep separate games', () => {
  const favorites = normalizeTeams([
    '  Spirit  ', 'spirit',
    { name: 'Falcons', game: 'csgo' }, { name: 'falcons', game: 'csgo' },
    { name: 'Falcons', game: 'dota2' },
    null, {}, { name: 123 }, { name: '   ' },
  ]);
  assert.equal(favorites.length, 3);
  assert.equal(isFollowed(favorites, 'SPIRIT', 'csgo'), true);
  assert.equal(isFollowed(favorites, 'Spirit', 'dota2'), true, 'legacy subscriptions apply across games');
  assert.equal(isFollowed(favorites, 'Falcons', 'valorant'), false);
  const after = toggleTeam(favorites, 'FALCONS', 'csgo');
  assert.equal(isFollowed(after, 'Falcons', 'csgo'), false);
  assert.equal(isFollowed(after, 'Falcons', 'dota2'), true);
  assert.equal(isFollowed(favorites, 'Falcons', 'csgo'), true, 'toggle must not mutate source');
  assert.equal(isFollowed(toggleTeam(after, 'Falcons', 'csgo'), 'Falcons', 'csgo'), true);
  assert.equal(isFollowed(toggleTeam(favorites, 'Spirit', 'csgo'), 'Spirit', 'csgo'), false);
  assert.deepEqual(normalizeTeams(null), []);
  assert.deepEqual(normalizeTeams({ name: 'Spirit' }), []);
});

test('safeURL accepts HTTPS only and blocks credentials and executable schemes', () => {
  assert.equal(safeURL('https://example.com/article?q=CS2#match'), 'https://example.com/article?q=CS2#match');
  for (const value of ['javascript:alert(1)', 'data:text/html,<h1>unsafe</h1>', 'http://example.com', '//example.com', '/local', 'https://user:password@example.com', 'https://user@example.com', '', null]) {
    assert.equal(safeURL(value), '', String(value));
  }
  assert.equal(escapeHTML('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHTML(null), '');
});

const calendarMatch = {
  id: 42, a: 'Team Spirit', b: 'Falcons', game: 'CS2', event: 'World Finals',
  t: '2026-11-11T10:00:00Z', bo: 3,
};
const fixedNow = new Date('2026-11-10T15:30:00Z');
const unfold = content => content.replace(/\r\n[ \t]/g, '');

test('calendarEvent produces UTC dates and duration, and rejects unknown start dates', () => {
  const event = calendarEvent(calendarMatch, fixedNow);
  assert.match(event, /DTSTAMP:20261110T153000Z\r\n/);
  assert.match(event, /DTSTART:20261111T100000Z\r\n/);
  assert.match(event, /DTEND:20261111T130000Z\r\n/);
  assert.match(calendarEvent({ ...calendarMatch, bo: 1 }, fixedNow), /DTEND:20261111T113000Z\r\n/);
  assert.ok(event.endsWith('END:VCALENDAR\r\n'));
  for (const t of ['', null, 'not-a-date']) assert.throws(() => calendarEvent({ ...calendarMatch, t }, fixedNow), /start is unknown/);
});

test('calendarEvent folds Cyrillic and emoji at 75 UTF-8 bytes without corrupting characters', () => {
  const title = 'Финал киберспорта 🏆 '.repeat(18);
  const event = calendarEvent({ ...calendarMatch, event: title, a: 'Команда '.repeat(20) }, fixedNow);
  const lines = event.split('\r\n');
  assert.ok(lines.some(line => line.startsWith(' ')), 'long fields must have continuation lines');
  for (const line of lines) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line exceeds limit: ${Buffer.byteLength(line, 'utf8')}`);
  assert.ok(unfold(event).includes(`DESCRIPTION:${title}\r\n`));
  assert.equal(event.includes('\uFFFD'), false);
  assert.equal(Buffer.from(event, 'utf8').toString('utf8'), event);
});

test('calendarEvent escapes field delimiters and CRLF/LF/CR injection', () => {
  const event = unfold(calendarEvent({
    ...calendarMatch,
    a: 'Team, One; \\ academy',
    event: 'Final\r\nBEGIN:VEVENT\nATTENDEE:attacker\rEND:VEVENT',
    id: '42\nSUMMARY:injected',
  }, fixedNow));
  const lines = event.split('\r\n');
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(lines.filter(line => line === 'END:VEVENT').length, 1);
  assert.equal(lines.filter(line => line.startsWith('SUMMARY:')).length, 1);
  assert.equal(lines.some(line => line.startsWith('ATTENDEE:')), false);
  assert.ok(event.includes('SUMMARY:Team\\, One\\; \\\\ academy vs Falcons (CS2)'));
  assert.ok(event.includes('DESCRIPTION:Final\\nBEGIN:VEVENT\\nATTENDEE:attacker\\nEND:VEVENT'));
  assert.equal(event.replace(/\r\n/g, '').includes('\r'), false, 'bare carriage returns must be escaped too');
});

test('news game detection handles source, translations, explicit tags, and game boundaries', () => {
  const samples = [
    [{ src: 'HLTV', title: 'The new roster' }, 'csgo'],
    [{ title: 'Counter-Strike tournament' }, 'csgo'],
    [{ tt: 'Новости Доты', title: 'Roster changes' }, 'dota2'],
    [{ title: 'Валорант: новый состав' }, 'valorant'],
    [{ sum: 'League of Legends final' }, 'lol'],
    [{ title: 'Rainbow Six playoffs' }, 'r6siege'],
    [{ title: 'Overwatch final' }, 'ow'],
    [{ ts: 'Rocket League' }, 'rl'],
    [{ title: 'Call of Duty schedule' }, 'codmw'],
    [{ game: 'dota2', title: 'Team news' }, 'dota2'],
    [{ games: ['csgo', 'valorant'], title: 'Club news' }, 'valorant'],
  ];
  for (const [item, game] of samples) assert.equal(newsMatchesGame(item, game), true, `${game}: ${JSON.stringify(item)}`);
  assert.equal(newsMatchesGame({ title: 'A club announcement' }, 'all'), true);
  assert.equal(newsMatchesGame({ title: 'lollipop championship' }, 'lol'), false);
  assert.equal(newsMatchesGame({ title: 'Dota 2 final' }, 'csgo'), false);
  assert.equal(newsMatchesGame({}, 'unknown'), false);
});
