// Pure helpers shared by the interface and the regression tests.
export const GAMES = [['all', 'Все игры'], ['csgo', 'CS2'], ['dota2', 'Dota 2'], ['valorant', 'Valorant'], ['lol', 'LoL'], ['r6siege', 'R6 Siege'], ['ow', 'Overwatch'], ['rl', 'Rocket League'], ['codmw', 'Call of Duty']];
export const COLORS = { csgo: '#c17a14', dota2: '#c74747', valorant: '#ce485c', lol: '#397bc5', r6siege: '#7e8ba2', ow: '#ca7428', rl: '#1586ad', codmw: '#668b28' };
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export const gameName = game => GAMES.find(([slug]) => slug === game)?.[1] || game || 'Все игры';
export function matchKind(match, fallback = 'up') {
  const statuses = { running: 'live', finished: 'past', not_started: 'up', canceled: 'canceled', postponed: 'postponed' };
  return statuses[match.status] || (match.win ? 'past' : fallback);
}
export function dateRange(period, tab = 'up', now = new Date()) {
  if (period === 'all') return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  if (period === 'tomorrow') start.setDate(start.getDate() + 1);
  if (period === 'yesterday') start.setDate(start.getDate() - 1);
  if (period === 'week' && tab === 'past') start.setDate(start.getDate() - 6);
  end.setTime(start.getTime());
  end.setDate(end.getDate() + (period === 'week' ? 7 : 1));
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}
export function filterMatches(matches, { game = 'all', query = '', from, to } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return matches.filter(m => {
    if (game !== 'all' && m.slug !== game) return false;
    const text = `${m.a} ${m.b} ${m.event} ${m.game}`.toLocaleLowerCase();
    if (!terms.every(term => text.includes(term))) return false;
    if (from || to) {
      const time = new Date(m.t).getTime();
      if (!Number.isFinite(time) || (from && time < Date.parse(from)) || (to && time > Date.parse(to))) return false;
    }
    return true;
  });
}
export function uniqueMatches(matches) {
  return [...new Map(matches.map(m => [String(m.id), m])).values()];
}
export function normalizeTeams(value) {
  if (!Array.isArray(value)) return [];
  const entries = value.map(t => typeof t === 'string' ? { name: t, game: '' } : t)
    .filter(t => t && typeof t.name === 'string' && t.name.trim())
    .map(t => ({ name: t.name.trim(), game: typeof t.game === 'string' ? t.game : '' }));
  return [...new Map(entries.map(t => [`${t.game}|${t.name.toLowerCase()}`, t])).values()];
}
export function isFollowed(teams, name, game) {
  return teams.some(t => t.name.toLowerCase() === name.toLowerCase() && (!t.game || t.game === game));
}
export function toggleTeam(teams, name, game) {
  if (isFollowed(teams, name, game)) return teams.filter(t => !(t.name.toLowerCase() === name.toLowerCase() && (!t.game || t.game === game)));
  return [...teams, { name, game }];
}
const newsPatterns = {
  csgo: /\b(?:cs2|cs:go|counter[ -]?strike|hltv)\b/i,
  dota2: /\bdota\b|дот[аыуе]/i,
  valorant: /\bvalorant\b|валорант/i,
  lol: /\bleague of legends\b|\blol\b|лига легенд/i,
  r6siege: /\brainbow six\b|\br6(?:siege)?\b/i,
  ow: /\boverwatch\b|оверво[тч]/i,
  rl: /\brocket league\b/i,
  codmw: /\bcall of duty\b|\bwarzone\b|\bCDL\b/i,
};
export function newsMatchesGame(item, game) {
  if (game === 'all') return true;
  if (item.game === game || item.games?.includes(game)) return true;
  return newsPatterns[game]?.test([item.src, item.title, item.sum, item.tt, item.ts].filter(Boolean).join(' ')) || false;
}
export function createRequestGate() {
  const active = new Map();
  return {
    begin(key) {
      active.get(key)?.abort();
      const controller = new AbortController();
      active.set(key, controller);
      return { signal: controller.signal, current: () => active.get(key) === controller && !controller.signal.aborted };
    },
    cancel(key) { active.get(key)?.abort(); active.delete(key); },
  };
}
const calendarEscape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&');
const calendarTime = value => new Date(value).toISOString().replace(/[-:]|\.\d+/g, '');
export function calendarEvent(match, now = new Date()) {
  if (!match.t || !Number.isFinite(Date.parse(match.t))) throw new Error('Match start is unknown');
  const end = Date.parse(match.t) + 3600000 * (match.bo > 1 ? 3 : 1.5);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EsportsPulse//RU', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${calendarEscape(match.id)}@esportspulse`, `DTSTAMP:${calendarTime(now)}`, `DTSTART:${calendarTime(match.t)}`, `DTEND:${calendarTime(end)}`,
    `SUMMARY:${calendarEscape(`${match.a} vs ${match.b} (${match.game})`)}`, `DESCRIPTION:${calendarEscape(match.event)}`, 'END:VEVENT', 'END:VCALENDAR'];
  // Fold by UTF-8 octets without splitting a Unicode code point (RFC 5545).
  return lines.map(line => {
    const parts = []; let part = '', size = 0;
    for (const char of line) {
      const bytes = new TextEncoder().encode(char).length;
      if (size + bytes > 75) { parts.push(part); part = ' '; size = 1; }
      part += char; size += bytes;
    }
    return [...parts, part].join('\r\n');
  }).join('\r\n') + '\r\n';
}
