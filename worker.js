// Cloudflare Worker: прокси PandaScore + Liquipedia + RSS новостей.
// Секреты: PANDASCORE_TOKEN, ALLOWED_ORIGIN, LP_USER_AGENT
const PS = 'https://api.pandascore.co';
// слаг PandaScore: [название, вики Liquipedia]
const G = { csgo: ['CS2', 'counterstrike'], dota2: ['Dota 2', 'dota2'], valorant: ['Valorant', 'valorant'], lol: ['League of Legends', 'leagueoflegends'], r6siege: ['Rainbow Six Siege', 'rainbowsix'], ow: ['Overwatch', 'overwatch'], rl: ['Rocket League', 'rocketleague'], codmw: ['Call of Duty', 'callofduty'] };
// У PandaScore в объектах слаги игр отличаются от слагов в адресах запросов (cs-go и csgo), приводим к виду адресов
const vs = s => ({ 'cs-go': 'csgo', 'dota-2': 'dota2', 'league-of-legends': 'lol', 'r6-siege': 'r6siege', 'cod-mw': 'codmw' }[s] || s || '');
// Игры для раздела «Турниры»: [слаг PandaScore, название].
const TG = [['csgo', 'Counter-Strike'], ['dota2', 'Dota 2'], ['valorant', 'Valorant'], ['lol', 'League of Legends'], ['r6siege', 'Rainbow Six Siege'], ['ow', 'Overwatch'], ['rl', 'Rocket League'], ['codmw', 'Call of Duty'], ['mlbb', 'Mobile Legends: Bang Bang'], ['kog', 'King of Glory'], ['starcraft-2', 'StarCraft 2'], ['pubg', 'PUBG'], ['fifa', 'EA Sports FC']];
const GAME_SLUGS = new Set(TG.map(([slug]) => slug));
const UPSTREAM_TIMEOUT_MS = 10000;
const MAX_LIVE_PAGES = 5;
// Источники новостей (RSS). Недоступные лента просто пропускается; добавляйте свои.
const FEEDS = [['Dot Esports', 'https://dotesports.com/feed', 'en'], ['Dexerto', 'https://www.dexerto.com/feed/', 'en'], ['Esports Insider', 'https://esportsinsider.com/feed', 'en'], ['HLTV', 'https://www.hltv.org/rss/news', 'en'], ['Cybersport.ru', 'https://www.cybersport.ru/rss', 'ru'], ['Sports.ru Киберспорт', 'https://cyber.sports.ru/rss/main.xml', 'ru']];

const memo = new Map();
const inflight = new Map();
async function cached(k, ttl, fn, shouldCache = () => true) {
  const h = memo.get(k);
  if (h && h.t > Date.now()) return h.v;
  if (inflight.has(k)) return inflight.get(k);
  const job = Promise.resolve().then(fn).then(v => {
    if (shouldCache(v)) memo.set(k, { v, t: Date.now() + ttl * 1000 });
    else memo.delete(k);
    if (memo.size > 300) memo.delete(memo.keys().next().value);
    return v;
  }).finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}
// Агрегаты объединяют одновременные вызовы, но не продлевают TTL закешированных частей.
const coalesced = (k, fn) => cached(k, 0, fn, () => false);
// Ограничиваем и получение ответа, и чтение тела; истёкший кеш не выдаём за свежие данные.
async function upstream(url, options, label, format = 'json') {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    if (!r.ok) throw new Error(label + ' ' + r.status);
    return { data: await r[format](), headers: r.headers };
  } catch (e) {
    if (controller.signal.aborted) throw new Error(label + ': timeout');
    throw e;
  } finally { clearTimeout(timer); }
}
const psResponse = (path, env) => upstream(PS + path, { headers: { Authorization: 'Bearer ' + env.PANDASCORE_TOKEN } }, 'PandaScore');
const ps = async (path, env) => (await psResponse(path, env)).data;
function hasNextPage(headers, page, size, length) {
  const total = headers.get('X-Total'), link = headers.get('Link');
  return total !== null && /^\d+$/.test(total) ? page * size < Number(total)
    : link !== null ? /rel="?next"?/.test(link) : length === size;
}
const badRequest = message => Object.assign(new Error(message), { status: 400 });
function selectedGames(value, multiple = false) {
  if (!value || value === 'all') return [];
  const games = [...new Set(value.split(',').map(s => vs(s.trim())))];
  if ((!multiple && games.length !== 1) || games.some(g => !GAME_SLUGS.has(g))) throw badRequest('Unknown game');
  return games;
}
function scheduleParams(q) {
  const game = selectedGames(q('game'))[0] || '', rawPage = q('page'), page = rawPage ? Number(rawPage) : 1;
  if (!Number.isSafeInteger(page) || page < 1) throw badRequest('page must be an integer >= 1');
  const from = q('from'), to = q('to');
  if (!!from !== !!to) throw badRequest('from and to must be provided together');
  const iso = value => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw badRequest('from and to must be ISO dates');
    if (new Date(value.slice(0, 10) + 'T00:00:00.000Z').toISOString().slice(0, 10) !== value.slice(0, 10))
      throw badRequest('from and to must be valid calendar dates');
    return new Date(value).toISOString();
  };
  const range = from ? [iso(from), iso(to)] : [];
  if (range.length && range[0] > range[1]) throw badRequest('from must not be after to');
  return { game, page, range };
}
async function schedule({ game, page, range }, env) {
  const query = new URLSearchParams({ per_page: '24', page: String(page) });
  if (range.length) query.set('range[begin_at]', range.join(','));
  const get = async (endpoint, sort) => {
    const params = new URLSearchParams(query); params.set('sort', sort);
    const { data, headers } = await psResponse(`${game ? '/' + game : ''}/matches/${endpoint}?${params}`, env);
    if (!Array.isArray(data)) throw new Error('PandaScore: invalid matches response');
    return { items: data.map(mm), more: hasNextPage(headers, page, 24, data.length) };
  };
  const [up, past] = await Promise.all([get('upcoming', 'begin_at'), get('past', '-begin_at')]);
  return { up: up.items, past: past.items, more: { up: up.more, past: past.more }, updatedAt: new Date().toISOString() };
}
async function tournaments(games, env) {
  const selected = games.length ? TG.filter(([slug]) => games.includes(slug)) : TG;
  const jobs = selected.flatMap(([slug, game]) => [['running', 'run', 'per_page=12'], ['upcoming', 'up', 'per_page=8&sort=begin_at']].map(([ep, s, qs]) => cached(`trb:${slug}:${ep}`, 600, async () => {
    const data = await ps(`/${slug}/tournaments/${ep}?${qs}`, env);
    if (!Array.isArray(data)) throw new Error('PandaScore: invalid tournaments response');
    return { items: data.map(t => ({ id: t.id, name: [t.league?.name, t.serie?.full_name, t.name].filter(Boolean).join(', '), game, slug, b: t.begin_at, e: t.end_at, pp: t.prizepool || null, s })), updatedAt: new Date().toISOString() };
  })));
  const results = await Promise.allSettled(jobs), successes = results.filter(r => r.status === 'fulfilled');
  if (!successes.length) throw new Error('PandaScore: tournaments unavailable');
  return { items: successes.flatMap(r => r.value.items), partial: successes.length !== results.length,
    updatedAt: successes.map(r => r.value.updatedAt).sort()[0] };
}

const tm = (m, i) => m.opponents?.[i]?.opponent;
// счёт серии: из results (по id команды или по порядку), а если там нули, то по победителям карт в games
const sc = (m, t) => {
  const r = m.results?.find(r => r.team_id === t?.id) ?? m.results?.[m.opponents?.findIndex(o => o.opponent?.id === t?.id)];
  return r?.score > 0 ? r.score : (m.games?.filter(g => g.winner?.id === t?.id).length || 0);
};
const ev = m => [m.league?.name, m.serie?.full_name].filter(Boolean).join(' ');
const mm = m => ({
  id: m.id, game: m.videogame?.name || '', slug: vs(m.videogame?.slug), event: ev(m), bo: m.number_of_games,
  status: m.status || null,
  a: tm(m, 0)?.name || 'TBD', b: tm(m, 1)?.name || 'TBD', x: sc(m, tm(m, 0)), y: sc(m, tm(m, 1)),
  aId: tm(m, 0)?.id ?? null, bId: tm(m, 1)?.id ?? null,
  aImg: tm(m, 0)?.image_url || null, bImg: tm(m, 1)?.image_url || null,
  t: m.begin_at || m.scheduled_at, win: m.winner?.name || null,
  stream: (m.streams_list?.find(s => s.main) || m.streams_list?.[0])?.raw_url || null,
});

async function wiki(name, g, env) {
  const wk = (G[g] || G.csgo)[1];
  const { data } = await upstream(`https://liquipedia.net/${wk}/api.php?action=parse&page=${encodeURIComponent(name)}&prop=wikitext&format=json&redirects=1`, { headers: { 'User-Agent': env.LP_USER_AGENT || 'EsportsPulse/1.0 (contact: you@example.com)' } }, 'Liquipedia');
  const t = (data.parse?.wikitext?.['*'] || '').replace(/<!--[\s\S]*?-->/g, '');
  const clean = v => v.replace(/\{\{[^}|]*\|?([^}]*)\}\}/g, '$1').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/['{}]/g, '').trim();
  const g1 = (...ks) => { for (const k of ks) { const m = t.match(new RegExp('^\\s*\\|\\s*' + k + '\\s*=([^\\n]*)', 'im')); const v = m && clean(m[1]); if (v) return v; } return ''; };
  return { team: g1('team'), role: g1('roles', 'role', 'role1', 'position', 'class'), real: g1('romanized_name', 'name'), page: `https://liquipedia.net/${wk}/${encodeURIComponent(name)}`, raw: t };
}

const f = (v, d = 2) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d));
async function player(name, game, team, env) {
  const list = await ps(`${game ? '/' + game : ''}/players?search[name]=${encodeURIComponent(name)}&per_page=30`, env);
  const same = list.filter(x => x.name.toLowerCase() === name.toLowerCase());
  const p = same.find(x => team && x.current_team?.name === team) || same[0] || list[0];
  if (!p) throw new Error('player not found');
  const g = game || vs(p.current_videogame?.slug) || 'csgo';
  const [st, ms, w] = await Promise.all([
    ps(`/${g}/players/${p.id}/stats`, env).catch(() => null),
    ps(`/players/${p.id}/matches?filter[status]=finished&sort=-begin_at&per_page=10`, env).catch(() => []),
    wiki(p.name, g, env).catch(() => ({})),
  ]);
  const av = st?.averages || st?.stats?.averages, cn = st?.counts || st?.stats?.counts || {};
  let rows = null;
  if (av && g === 'csgo') rows = [['Рейтинг', f(av.hltv_game_rating)], ['K/D', f(av.deaths ? av.kills / av.deaths : null)], ['ADR', f(av.adr, 1)], ['Хедшоты, %', f(av.kills ? av.headshots / av.kills * 100 : null, 0)], ['KAST, %', f(av.kast <= 1 ? av.kast * 100 : av.kast, 0)], ['Карт', cn.games_played ?? '—']];
  else if (av) rows = Object.entries(av).filter(([, v]) => typeof v === 'number').slice(0, 6).map(([k, v]) => [k.replace(/_/g, ' '), f(v, 1)]);
  const tid = p.current_team?.id;
  return {
    name: p.name, game: g, gameName: (G[g] || [g])[0], nat: p.nationality || '', img: p.image_url || null, lp: w.page,
    real: w.real || [p.first_name, p.last_name].filter(Boolean).join(' '),
    team: p.current_team?.name || w.team || '', role: w.role || p.role || '',
    stats: rows && rows.length ? rows : null,
    history: ms.map(m => {
      const i = m.opponents?.findIndex(o => o.opponent?.id === tid) ?? -1, a = tm(m, 0), b = tm(m, 1);
      return i < 0 ? { d: m.begin_at, o: `${a?.name || 'TBD'} vs ${b?.name || 'TBD'}`, e: ev(m), sc: `${sc(m, a)}:${sc(m, b)}`, w: null }
        : { d: m.begin_at, o: tm(m, 1 - i)?.name || 'TBD', e: ev(m), sc: `${sc(m, tm(m, i))}:${sc(m, tm(m, 1 - i))}`, w: m.winner_id === tid };
    }),
  };
}

// g = '' значит «все игры»; team = поиск команд по названию
async function roster(g, page, team, env) {
  const t = await ps(`${g ? '/' + g : ''}/teams?per_page=50&page=${page}&sort=name${team ? '&search[name]=' + encodeURIComponent(team) : ''}`, env);
  return { more: t.length === 50, items: t.flatMap(x => (x.players || []).map(p => ({ name: p.name, team: x.name, role: p.role || '', img: p.image_url || null, game: vs(x.current_videogame?.slug) || g }))) };
}

async function team(name, game, env) {
  const t = await cached(`ti:${game}:${name.toLowerCase()}`, 300, async () => {
    const list = await ps(`${game ? '/' + game : ''}/teams?search[name]=${encodeURIComponent(name)}&per_page=10`, env);
    if (!Array.isArray(list)) throw new Error('PandaScore: invalid teams response');
    const found = list.find(x => x.name.toLowerCase() === name.toLowerCase()) || list[0];
    if (!found) throw new Error('team not found');
    return found;
  });
  // Матчи конкретной команды не зависят от первых страниц общего расписания/live.
  const sections = [['live', 'running', 'begin_at', 6, 30], ['up', 'not_started', 'begin_at', 6, 300], ['past', 'finished', '-begin_at', 8, 300]];
  const results = await Promise.allSettled(sections.map(([key, status, sort, size, ttl]) => cached(`tms:${t.id}:${key}`, ttl, async () => {
    const data = await ps(`/teams/${t.id}/matches?filter[status]=${status}&sort=${sort}&per_page=${size}`, env);
    if (!Array.isArray(data)) throw new Error('PandaScore: invalid team matches response');
    return { items: data.map(mm), updatedAt: new Date().toISOString() };
  })));
  const unavailable = sections.filter((_, i) => results[i].status === 'rejected').map(([key]) => key);
  if (unavailable.length === sections.length) throw new Error('PandaScore: team matches unavailable');
  const matches = Object.fromEntries(sections.map(([key], i) => [key, results[i].status === 'fulfilled' ? results[i].value.items : []]));
  const updatedAt = results.filter(r => r.status === 'fulfilled').map(r => r.value.updatedAt).sort()[0];
  return { id: t.id, name: t.name, game: vs(t.current_videogame?.slug) || game, gameName: t.current_videogame?.name || '', img: t.image_url || null,
    players: (t.players || []).map(p => ({ name: p.name, role: p.role || '', img: p.image_url || null })), ...matches,
    partial: unavailable.length > 0, unavailable, updatedAt };
}
// ---------- Умный поиск: ник, команда или оба слова сразу ("Falcons kyousuke"), по всем играм, с допуском опечаток ----------
const STOP = new Set(['team', 'esports', 'gaming', 'club', 'fc']);
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
async function search(text, game, env) {
  const all = text.toLowerCase().split(/[\s,]+/).filter(t => t.length > 1);
  const toks = [...new Set(all.some(t => !STOP.has(t)) ? all.filter(t => !STOP.has(t)) : all)].slice(0, 3);
  if (!toks.length) return [];
  let fails = 0;
  const pre = game ? '/' + game : ''; // выбранная игра ограничивает поиск
  const get = p => ps(p, env).catch(() => (fails++, [])), e = encodeURIComponent, tq = toks.length > 1 ? [...toks, text.toLowerCase()] : toks;
  const [pl, tm] = await Promise.all([
    Promise.all(toks.map(t => get(`${pre}/players?search[name]=${e(t)}&per_page=30`))),
    Promise.all(tq.map(t => get(`${pre}/teams?search[name]=${e(t)}&per_page=10`))),
  ]);
  if (fails === toks.length + tq.length) throw new Error('PandaScore недоступен');
  const seen = new Map();
  const add = (p, team, vg) => { const gm = vs(vg?.slug) || game, k = `${gm}|${p.name}|${team}`.toLowerCase(); if (!seen.has(k)) seen.set(k, { name: p.name, team, role: p.role || '', img: p.image_url || null, game: gm, gn: vg?.name || '' }); };
  pl.flat().forEach(p => add(p, p.current_team?.name || '', p.current_videogame));
  tm.flat().forEach(t => (t.players || []).forEach(p => add(p, t.name, t.current_videogame)));
  const sc = c => {
    const n = c.name.toLowerCase(), t = c.team.toLowerCase();
    let s = 0, hit = 0, byN = 0, byT = 0;
    for (const k of toks) {
      const a = n === k ? 3 : n.startsWith(k) ? 2 : n.includes(k) ? 1.5 : lev(n, k) <= (k.length >= 6 ? 2 : k.length >= 4 ? 1 : 0) ? 1.2 : 0, b = t.includes(k) ? 1 : 0;
      if (a || b) hit++;
      if (a) byN++; else if (b) byT++;
      s += Math.max(a, b);
    }
    return { all: hit === toks.length, s: s + (byN && byT ? 2 : 0) };
  };
  return [...seen.values()].map(c => ({ c, r: sc(c) })).filter(x => x.r.s > 0 && (!game || !x.c.game || x.c.game === game))
    .sort((a, b) => (b.r.all - a.r.all) || (b.r.s - a.r.s) || a.c.name.localeCompare(b.c.name)).slice(0, 40).map(x => x.c);
}
const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
async function feed([src, url, lang]) {
  const { data: x } = await upstream(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EsportsPulse/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' } }, src, 'text');
  const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };
  return [...x.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 12).map(([it]) => {
    const d = dec(tag(it, 'description') || tag(it, 'content:encoded'));
    const img = (it.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*url=["']([^"']+)/i) || d.match(/<img[^>]*src=["']([^"']+)/i) || [])[1] || null;
    return { src, lang, title: dec(tag(it, 'title')), link: tag(it, 'link'), date: new Date(tag(it, 'pubDate') || tag(it, 'dc:date')).getTime() || 0, sum: d.replace(/<[^>]+>/g, '').trim().slice(0, 220), img };
  });
}
async function news(env, ctx) {
  const res = await Promise.allSettled(FEEDS.map(feed));
  const items = res.flatMap(r => (r.status === 'fulfilled' ? r.value : [])).filter(n => n.title && /^https?:/.test(n.link)).sort((a, b) => b.date - a.date).slice(0, 80);
  await translate(items, env, ctx).catch(() => {});
  return { items, status: FEEDS.map(([s], i) => ({ src: s, ok: res[i].status === 'fulfilled', n: res[i].value?.length ?? 0 })) };
}

// ---------- Перевод новостей (Workers AI) ----------
let TRM = {}; // запасной кэш в памяти, если KV не подключён
const liveMatchResult = (env, game = '') => coalesced('live:' + game, async () => {
  const items = new Map(), timestamps = [];
  let partial = false;
  for (let page = 1; page <= MAX_LIVE_PAGES; page++) {
    try {
      const result = await cached(`live-page:${game}:${page}`, 30, async () => {
        const { data, headers } = await psResponse(`${game ? '/' + game : ''}/matches/running?per_page=100&page=${page}&sort=id`, env);
        if (!Array.isArray(data)) throw new Error('PandaScore: invalid live matches response');
        return { items: data.map(mm), more: hasNextPage(headers, page, 100, data.length), updatedAt: new Date().toISOString() };
      });
      result.items.forEach(match => items.set(match.id, match));
      timestamps.push(result.updatedAt);
      if (!result.more) break;
      if (page === MAX_LIVE_PAGES) partial = true;
    } catch (e) {
      if (page === 1) throw e;
      partial = true;
      break;
    }
  }
  return { items: [...items.values()], partial, updatedAt: timestamps.sort()[0] };
});
// Бот сохраняет прежний контракт массива.
const liveMatches = async env => (await liveMatchResult(env)).items;
async function tr(env, text) {
  if (!text) return '';
  try { return (await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'english', target_lang: 'russian' })).translated_text || ''; } catch (e) { return ''; }
}
// Уже готовые переводы подставляются сразу, недостающие переводятся в фоне и попадут в следующий выпуск (через ~10 минут)
async function translate(items, env, ctx) {
  if (!env.AI) return;
  const map = (env.KV ? await env.KV.get('tr', 'json').catch(() => null) : null) || TRM;
  items.forEach(x => { const m = map[x.link]; if (m) { x.tt = m.t; x.ts = m.s || ''; } });
  const job = (async () => {
    let dirty = false;
    await Promise.all(items.filter(x => x.lang === 'en' && !map[x.link]).slice(0, 15).map(async x => {
      const t = await tr(env, x.title);
      if (t) { map[x.link] = { t, s: await tr(env, x.sum) }; dirty = true; }
    }));
    if (!dirty) return;
    const ks = Object.keys(map);
    if (ks.length > 600) ks.slice(0, ks.length - 600).forEach(k => delete map[k]);
    TRM = map;
    if (env.KV) await env.KV.put('tr', JSON.stringify(map)).catch(() => {});
  })().catch(() => {});
  if (ctx) ctx.waitUntil(job); else await job;
}

// ---------- Telegram-бот ----------
const COMMANDS = [['follow', 'Следить за командой'], ['unfollow', 'Перестать следить'], ['list', 'Мои команды'], ['live', 'Матчи в эфире'], ['news', 'Свежие новости'], ['digest', 'Утренний дайджест вкл/выкл']].map(([command, description]) => ({ command, description }));
const HELP = 'Я слежу за киберспортом.\n/follow Team Spirit: следить за командой, напомню о матче за 10-15 минут\n/unfollow Team Spirit: перестать следить\n/list: мои команды\n/live: матчи в эфире\n/news: свежие новости\n/digest: утренний дайджест в 11:00 по Казахстану (вкл/выкл)';
const tgApi = async (env, method, body) => (await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null))?.json().catch(() => null);
const send = (env, chat, text) => tgApi(env, 'sendMessage', { chat_id: chat, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } });
const headline = x => `• ${x.tt || x.title}\n${x.link}`;

async function tg(req, env) {
  const ok = new Response('ok');
  if (!env.TG_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
  const m = (await req.json().catch(() => ({}))).message;
  if (!m?.text || !env.KV) return ok;
  const chat = String(m.chat.id), [cmd, ...rest] = m.text.trim().split(/\s+/), arg = rest.join(' ').trim(), c = cmd.split('@')[0].toLowerCase();
  const subs = (await env.KV.get('subs', 'json')) || {}, me = subs[chat] || { teams: [], digest: false };
  const save = () => { subs[chat] = me; return env.KV.put('subs', JSON.stringify(subs)); };
  let r;
  try {
    if (!subs[chat] && Object.keys(subs).length >= 500) r = 'Сейчас бот переполнен, попробуйте позже.';
    else if (c === '/start' || c === '/help') r = HELP;
    else if (c === '/follow') {
      if (!arg) r = 'Напишите название команды, например: /follow Team Spirit';
      else {
        const t = await ps(`/teams?search[name]=${encodeURIComponent(arg.slice(0, 40))}&per_page=5`, env), x = t.find(y => y.name.toLowerCase() === arg.toLowerCase()) || t[0];
        if (!x) r = 'Такую команду не нашёл.';
        else if (me.teams.length >= 15 && !me.teams.includes(x.name)) r = 'Можно следить максимум за 15 командами.';
        else { if (!me.teams.includes(x.name)) me.teams.push(x.name); await save(); r = `Слежу за командой ${x.name}. Напомню о её матчах за 10-15 минут до начала.`; }
      }
    } else if (c === '/unfollow') {
      const n = me.teams.length; me.teams = me.teams.filter(x => x.toLowerCase() !== arg.toLowerCase());
      if (me.teams.length < n) { await save(); r = 'Больше не слежу за этой командой.'; } else r = 'Такой команды нет в вашем списке. Посмотрите /list.';
    } else if (c === '/list') r = (me.teams.length ? 'Ваши команды: ' + me.teams.join(', ') : 'Вы пока ни за кем не следите. Попробуйте /follow Team Spirit.') + '\nУтренний дайджест: ' + (me.digest ? 'включён' : 'выключен');
    else if (c === '/digest') { me.digest = !me.digest; await save(); r = me.digest ? 'Утренний дайджест включён: каждый день в 11:00 по Казахстану.' : 'Утренний дайджест выключен.'; }
    else if (c === '/live') { const l = (await liveMatches(env)).slice(0, 10); r = l.length ? 'Сейчас в эфире:\n' + l.map(x => `${x.game}: ${x.a} ${x.x}:${x.y} ${x.b}${x.stream ? '\n' + x.stream : ''}`).join('\n\n') : 'Сейчас нет матчей в эфире.'; }
    else if (c === '/news') r = 'Свежие новости:\n\n' + (await cached('news', 600, () => news(env))).items.slice(0, 5).map(headline).join('\n\n');
    else r = 'Не понял команду.\n\n' + HELP;
  } catch (e) { r = 'Не получилось, попробуйте позже (' + (e.message || e) + ').'; }
  await send(env, chat, r);
  return ok;
}

// Cron: каждые 5 минут напоминания о матчах, раз в сутки дайджест
async function cron(c, env) {
  if (!env.KV || !env.TG_TOKEN) return;
  const subs = (await env.KV.get('subs', 'json')) || {}, ids = Object.keys(subs);
  if (!ids.length) return;
  if (c === '0 6 * * *') {
    const d = ids.filter(i => subs[i].digest); if (!d.length) return;
    const text = 'Новости киберспорта:\n\n' + (await cached('news', 600, () => news(env))).items.slice(0, 5).map(headline).join('\n\n');
    for (const i of d.slice(0, 40)) await send(env, i, text);
    return;
  }
  const now = Date.now(), up = (await cached('upc', 240, () => ps('/matches/upcoming?per_page=50&sort=begin_at', env))).map(mm);
  let sent = 0; // лимит подзапросов на одну сессию Worker
  for (const m of up.filter(x => { const t = new Date(x.t).getTime(); return t > now + 10 * 6e4 && t <= now + 15 * 6e4; })) {
    for (const i of ids) {
      const f = subs[i].teams.map(x => x.toLowerCase());
      if ((f.includes(m.a.toLowerCase()) || f.includes(m.b.toLowerCase())) && sent++ < 40)
        await send(env, i, `${m.game}: ${m.a} vs ${m.b}\nНачало примерно через ${Math.round((new Date(m.t) - now) / 6e4)} мин.\n${m.event}${m.stream ? '\n' + m.stream : ''}`);
    }
  }
}

export default {
  scheduled(event, env, ctx) { ctx.waitUntil(cron(event.cron, env)); },
  async fetch(req, env, ctx) {
    const u = new URL(req.url), q = k => (u.searchParams.get(k) || '').trim();
    // ALLOWED_ORIGIN: один адрес сайта или несколько через запятую (без слэша на конце), по умолчанию доступ открыт всем
    const allow = (env.ALLOWED_ORIGIN || '*').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean), org = req.headers.get('Origin');
    const h = { 'Access-Control-Allow-Origin': allow.includes('*') ? '*' : (allow.includes(org) ? org : allow[0]), Vary: 'Origin', 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Expose-Headers': 'X-Data-Partial, X-Data-Updated-At' };
    const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: h });
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    try {
      const g = G[q('game')] ? q('game') : '';
      switch (u.pathname) {
        case '/live': {
          const game = selectedGames(q('game'))[0] || '', result = await liveMatchResult(env, game);
          h['X-Data-Partial'] = String(result.partial);
          h['X-Data-Updated-At'] = result.updatedAt;
          return out(q('meta') === '1' ? result : result.items);
        }
        case '/schedule': {
          const params = scheduleParams(q);
          return out(await cached('sch:' + JSON.stringify(params), 300, () => schedule(params, env)));
        }
        case '/players': {
          const pg = Math.max(1, +q('page') || 1), gg = q('game') === 'all' ? '' : (g || 'csgo'), tq = q('team').slice(0, 40);
          return out(await cached(`r:${gg}:${pg}:${tq.toLowerCase()}`, 600, () => roster(gg, pg, tq, env)));
        }
        case '/player': { const n = q('name').slice(0, 40); if (!n) return out({ error: 'name is required' }, 400); return out(await cached(`p:${g}:${n.toLowerCase()}:${q('team')}`, 900, () => player(n, g, q('team').slice(0, 40), env))); }
        case '/wiki': return out({ raw: (await wiki(q('name').slice(0, 40), g || 'csgo', env)).raw.slice(0, 2500) }); // отладка ролей
        case '/team': {
          const n = q('name').slice(0, 40), game = selectedGames(q('game'))[0] || '';
          if (!n) return out({ error: 'name is required' }, 400);
          return out(await coalesced(`t:${game}:${n.toLowerCase()}`, () => team(n, game, env)));
        }
        case '/tournaments': {
          const games = selectedGames(q('game'), true).sort();
          const result = await coalesced('tr:' + games.join(','), () => tournaments(games, env));
          return out(q('meta') === '1' ? result : result.items);
        }
        case '/tournament': { const id = +q('id'); if (!id) return out({ error: 'id is required' }, 400); return out(await cached('tm:' + id, 300, async () => (await ps(`/tournaments/${id}/matches?sort=begin_at&per_page=40`, env)).map(mm))); }
        case '/telegram': return req.method === 'POST' ? tg(req, env) : out({ error: 'POST only' }, 405);
        case '/tg-setup': { // разовая настройка бота: /tg-setup?key=<TG_SECRET>
          if (!env.TG_SECRET || !env.TG_TOKEN || q('key') !== env.TG_SECRET) return out({ error: 'forbidden' }, 403);
          const hook = await tgApi(env, 'setWebhook', { url: u.origin + '/telegram', secret_token: env.TG_SECRET, allowed_updates: ['message'] });
          const cmds = await tgApi(env, 'setMyCommands', { commands: COMMANDS });
          return out({ webhook: hook, commands: cmds });
        }
        case '/search': { const t = q('q').slice(0, 60), sg = /^[a-z0-9-]{2,20}$/.test(q('game')) && q('game') !== 'all' ? q('game') : ''; if (t.length < 2) return out({ items: [] }); return out({ items: await cached(`s:${sg}:${t.toLowerCase()}`, 600, () => search(t, sg, env)) }); }
        case '/news': return out(await cached('news', 600, () => news(env, ctx)));
        default: return out({ error: 'not found' }, 404);
      }
    } catch (e) { return out({ error: String(e.message || e) }, e.status === 400 ? 400 : 502); }
  },
};
