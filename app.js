import { GAMES as GL, COLORS as GC, escapeHTML as esc, safeURL, gameName, matchKind, dateRange, filterMatches, uniqueMatches, normalizeTeams, isFollowed, toggleTeam, newsMatchesGame, createRequestGate, calendarEvent } from './app-core.js';

const API = 'https://esports-pulse-api.sdtwg.workers.dev';
const $ = selector => document.querySelector(selector);
const hs = value => esc(safeURL(value));
const store = (key, value) => {
  try { if (value === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return value === undefined ? null : false; }
};
const arrayStore = key => { const value = store(key); return Array.isArray(value) ? value : []; };
const gates = createRequestGate();
const qs = values => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '' && v !== null) p.set(k, v); return '?' + p; };
async function api(path, signal) {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 20000);
  try { const response = await fetch(API + path, { signal: controller.signal }); if (!response.ok) throw new Error('HTTP ' + response.status); return await response.json(); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
const clockTime = value => new Date(value).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const fmt = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Время уточняется';
const ago = value => {
  const time = new Date(value).getTime(); if (!time || !Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1 ? 'только что' : minutes < 60 ? `${minutes} мин назад` : minutes < 1440 ? `${Math.floor(minutes / 60)} ч назад` : fmt(value);
};
const until = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'время уточняется';
  const minutes = Math.ceil((Date.parse(value) - Date.now()) / 60000);
  return minutes <= 0 ? 'ожидаем начала' : minutes < 60 ? `через ${minutes} мин` : minutes < 1440 ? `через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : fmt(value);
};
const RU = { awper: 'Снайпер (AWP)', awp: 'Снайпер (AWP)', rifler: 'Райфлер', igl: 'Капитан (IGL)', 'in-game leader': 'Капитан (IGL)', support: 'Саппорт', sup: 'Саппорт', lurker: 'Лёрк', entry: 'Энтри-фрагер', carry: 'Керри', mid: 'Мид', offlane: 'Оффлейн', top: 'Топ', jungle: 'Лесник', adc: 'Стрелок', bot: 'Стрелок', duelist: 'Дуэлянт', initiator: 'Инициатор', controller: 'Контроллер', sentinel: 'Страж', flex: 'Флекс', tank: 'Танк', dps: 'ДПС', damage: 'ДПС', coach: 'Тренер', sniper: 'Снайпер' };
const role = value => value ? String(value).split(/[,/;]|\band\b/i).map(x => x.trim()).filter(Boolean).map(x => RU[x.toLowerCase()] || x).join(', ') : 'не указана';
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function save(key, value) { if (!store(key, value)) toast('Не удалось сохранить настройки в этом браузере.'); }
const stateBox = (title, text = '', action = '') => `<div class="state-box"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
const retry = key => `<button class="mo" data-retry="${key}">Повторить</button>`;
const loading = (text = 'Загрузка…') => `<div class="load-placeholder" role="status">${esc(text)}</div>`;
const state = () => ({ loading: false, error: false, updated: null });
function statusMarkup(s, key, extra = '') {
  const time = s.updated ? `Последнее обновление: ${clockTime(s.updated)}.` : '';
  if (s.error) return `<span>Не удалось обновить данные. ${time} ${s.updated ? 'Показана последняя загруженная версия.' : ''}</span> ${retry(key)}`;
  if (s.loading) return `<span>Обновляем… ${time}</span>`;
  return `<span>${s.updated ? `Обновлено в ${clockTime(s.updated)}.` : ''} ${esc(extra)}</span>`;
}
function chips(selector, items, selected, onSelect) {
  const signature = JSON.stringify([items, selected]);
  if ($(selector).dataset.chips === signature) return;
  $(selector).dataset.chips = signature;
  $(selector).innerHTML = items.map(([key, label]) => `<button type="button" class="${key === selected ? 'on' : ''}" aria-pressed="${key === selected}" data-k="${esc(key)}">${esc(label)}</button>`).join('');
  $(selector).querySelectorAll('button').forEach(button => { button.onclick = () => onSelect(button.dataset.k); });
}
function replaceMarkup(element, html) {
  if (element.innerHTML === html) return;
  const focused = document.activeElement;
  const restore = focused && element.contains(focused) && Object.keys(focused.dataset || {}).length;
  const identity = restore ? { ...focused.dataset } : null;
  const matchId = restore ? focused.closest('[data-match]')?.dataset.match : null;
  element.innerHTML = html;
  if (identity) {
    const replacement = [...element.querySelectorAll('button,a,input')].find(node => Object.entries(identity).every(([key, value]) => node.dataset[key] === value) && (!matchId || node.closest('[data-match]')?.dataset.match === matchId));
    replacement?.focus({ preventScroll: true });
  }
}
let game = GL.some(([key]) => key === store('game')) ? store('game') : 'all';
let followed = normalizeTeams(store('ft')), hideScores = store('hideScores') === true, currentDetail = null;
const revealed = new Set(), matches = new Map();
const D = document.documentElement;
if (['light', 'dark'].includes(store('th'))) D.dataset.theme = store('th');
function themeLabel() {
  const dark = D.dataset.theme ? D.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  $('#tg').setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему'); $('#tg').setAttribute('aria-pressed', String(dark));
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = dark ? '#040606' : '#f5efdf'; });
}
$('#tg').onclick = () => { const dark = D.dataset.theme ? D.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches; D.dataset.theme = dark ? 'light' : 'dark'; save('th', D.dataset.theme); themeLabel(); };
themeLabel();
function renderGames() { for (const id of ['#global-games', '#mf', '#tgf', '#pf']) chips(id, GL, game, selectGame); }
function selectGame(next) {
  if (game === next) return;
  game = next; save('game', game); newsLimit = 6; searchAll = false;
  clearTimeout(searchTimer); gates.cancel('search'); searchQuery = $('#q').value.trim(); searchResult = null;
  renderGames(); renderNews(); renderHero(); renderFavorites();
  loadLive(true); loadSchedule(true); loadTournaments(true); loadPlayers(true);
  if (searchQuery.length > 1) searchPlayers(searchQuery);
}
const offset = -new Date().getTimezoneOffset();
$('#timezone').textContent = `Ваше время · UTC${offset >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
$('#hide-scores').checked = hideScores;
$('#hide-scores').onchange = event => { hideScores = event.target.checked; save('hideScores', hideScores); revealed.clear(); renderMatches(); renderFavorites(); renderDetail(); };
addEventListener('error', event => {
  const img = event.target; if (!img || img.tagName !== 'IMG' || img.dataset.fb) return;
  img.dataset.fb = '1';
  if (img.closest('.av')) { img.replaceWith(document.createTextNode(img.dataset.initial || '?')); return; }
  if (img.classList.contains('team-logo')) { img.hidden = true; return; }
  const fallback = document.createElement('div'); fallback.className = 'fb'; fallback.textContent = 'Esports Pulse'; img.replaceWith(fallback);
}, true);

const cachedNews = store('newsCache');
let news = Array.isArray(cachedNews?.items) ? cachedNews.items : [];
const newsState = { ...state(), updated: cachedNews?.updated || null };
let newsSource = 'Все', newsLimit = 6, original = store('orig') === true, heroIndex = 0, heroTimer, heroPaused = true;
const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
const title = item => !original && item.tt ? item.tt : item.title;
const summary = item => !original && item.tt && item.ts ? item.ts : item.sum;
function newsList() {
  const source = newsSource === 'saved' ? arrayStore('bk') : news, query = $('#nq').value.trim().toLowerCase();
  return source.filter(item => newsMatchesGame(item, game) && (newsSource === 'Все' || newsSource === 'saved' || item.src === newsSource) && (!query || `${title(item)} ${item.title} ${summary(item)}`.toLowerCase().includes(query)));
}
function renderNews() {
  const saved = arrayStore('bk'), sources = [...new Set(news.map(n => n.src))];
  chips('#nf', [['Все', 'Все источники'], ...sources.map(x => [x, x]), ['saved', `Сохранённые (${saved.length})`]], newsSource, next => { newsSource = next; newsLimit = 6; renderNews(); });
  const filters = $('#nf');
  let language = filters.querySelector('[data-news-language]');
  if (!language) {
    language = document.createElement('button'); language.type = 'button'; language.className = 'mo';
    language.setAttribute('data-news-language', '');
    language.onclick = () => { original = !original; save('orig', original); renderNews(); renderHero(); };
    filters.append(language);
  }
  language.textContent = original ? 'Показать перевод' : 'Показать оригинал';
  language.setAttribute('aria-pressed', String(original));
  $('#news-status').innerHTML = statusMarkup(newsState, 'news');
  const all = newsList(), visible = all.slice(0, newsLimit);
  $('#ng').innerHTML = visible.length ? visible.map((n, i) => {
    const savedItem = saved.some(x => x.link === n.link);
    const body = `${hs(n.img) ? `<img src="${hs(n.img)}" loading="lazy" referrerpolicy="no-referrer" alt="" width="480" height="260">` : ''}<span class="ds">${esc(n.src)} · ${esc(ago(n.date))}${!original && n.tt ? ' · перевод' : ''}</span><b>${esc(title(n))}</b>`;
    return `<article class="cd nc">${hs(n.link) ? `<a class="na" href="${hs(n.link)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<div class="na">${body}</div>`}<button class="fv bk" data-news="${i}" aria-pressed="${savedItem}" aria-label="${savedItem ? 'Убрать из сохранённого' : 'Сохранить новость'}">${savedItem ? '★' : '☆'}</button></article>`;
  }).join('') : newsState.loading && !news.length ? loading('Загружаем новости…') : stateBox(newsState.error && !news.length && newsSource !== 'saved' ? 'Новости временно недоступны' : newsSource === 'saved' ? 'Сохранённых новостей пока нет' : 'По вашим фильтрам нет новостей', newsSource === 'saved' ? 'Нажмите на звезду у интересной публикации.' : 'Попробуйте другую игру, источник или поисковый запрос.');
  $('#ng').querySelectorAll('[data-news]').forEach(button => { button.onclick = () => { const n = visible[Number(button.dataset.news)], items = arrayStore('bk'); save('bk', items.some(x => x.link === n.link) ? items.filter(x => x.link !== n.link) : [...items, n]); renderNews(); }; });
  $('#news-more').innerHTML = all.length > visible.length ? `<button class="mo" id="more-news">Ещё новости · осталось ${all.length - visible.length}</button>` : '';
  if ($('#more-news')) $('#more-news').onclick = () => { newsLimit += 6; renderNews(); };
}
function renderHero() {
  clearInterval(heroTimer);
  const host = $('#hero'), items = news.filter(n => newsMatchesGame(n, game)).slice(0, 4);
  host.onmouseenter = host.onmouseleave = host.onfocusin = host.onfocusout = null;
  if (!items.length) { host.classList.add('hero-empty'); host.innerHTML = stateBox(newsState.loading ? 'Ищем главные новости' : newsState.error ? 'Лента временно недоступна' : 'Новости вашей игры появятся здесь', 'Матчи, турниры и избранное доступны в своих разделах.'); return; }
  host.classList.remove('hero-empty'); heroIndex %= items.length;
  host.innerHTML = items.map((n, index) => `<article class="sl${index === heroIndex ? ' on' : ''}" aria-roledescription="слайд" aria-label="${index + 1} из ${items.length}" ${index !== heroIndex ? 'inert aria-hidden="true"' : ''}>${hs(n.img) ? `<img src="${hs(n.img)}" ${index ? 'loading="lazy"' : ''} referrerpolicy="no-referrer" alt="">` : '<div class="bg"></div>'}<div class="sh"></div><div class="tx"><span class="tg">${esc(n.src)}</span><h2>${hs(n.link) ? `<a href="${hs(n.link)}" target="_blank" rel="noopener noreferrer">${esc(title(n))}</a>` : esc(title(n))}</h2><p>${esc(summary(n))}</p></div></article>`).join('') + (items.length > 1 ? '<button class="ar pv" aria-label="Предыдущая новость">‹</button><button class="ar nx" aria-label="Следующая новость">›</button><div class="dots">' + items.map((_, i) => `<button aria-label="Новость ${i + 1}" data-slide="${i}"></button>`).join('') + '</div><button class="hero-pause" type="button"></button>' : '');
  if (items.length < 2) return;
  const slides = [...host.querySelectorAll('.sl')], dots = [...host.querySelectorAll('[data-slide]')], pause = host.querySelector('.hero-pause');
  let hovering = false;
  const go = next => {
    heroIndex = (next + items.length) % items.length;
    slides.forEach((slide, i) => { slide.classList.toggle('on', i === heroIndex); slide.inert = i !== heroIndex; slide.setAttribute('aria-hidden', String(i !== heroIndex)); });
    dots.forEach((dot, i) => { dot.classList.toggle('on', i === heroIndex); dot.setAttribute('aria-pressed', String(i === heroIndex)); });
  };
  const play = () => {
    clearInterval(heroTimer); pause.textContent = heroPaused || reducedMotion.matches ? 'Автосмена: выкл.' : 'Пауза';
    pause.setAttribute('aria-label', heroPaused ? 'Включить автоматическую смену новостей' : 'Остановить автоматическую смену новостей'); pause.disabled = reducedMotion.matches;
    if (!heroPaused && !reducedMotion.matches && !hovering && !document.hidden && !host.contains(document.activeElement)) heroTimer = setInterval(() => go(heroIndex + 1), 8000);
  };
  host.querySelector('.pv').onclick = () => { go(heroIndex - 1); play(); }; host.querySelector('.nx').onclick = () => { go(heroIndex + 1); play(); };
  dots.forEach((dot, i) => { dot.onclick = () => { go(i); play(); }; }); pause.onclick = () => { heroPaused = !heroPaused; play(); };
  host.onmouseenter = () => { hovering = true; play(); }; host.onmouseleave = () => { hovering = false; play(); };
  host.onfocusin = () => clearInterval(heroTimer); host.onfocusout = () => setTimeout(play, 0);
  go(heroIndex); play();
}
async function loadNews() {
  const request = gates.begin('news'); newsState.loading = true; renderNews(); renderHero();
  try {
    const data = await api('/news', request.signal); if (!request.current()) return;
    if (!Array.isArray(data.items) || !data.items.length) throw new Error('No feeds available');
    news = data.items; newsState.updated = new Date().toISOString(); newsState.error = false;
    store('newsCache', { items: news.slice(0, 60), updated: newsState.updated });
  } catch { if (!request.current()) return; newsState.error = true; }
  newsState.loading = false; renderNews(); renderHero();
}
$('#nq').oninput = () => { newsLimit = 6; renderNews(); };
reducedMotion.addEventListener('change', renderHero);

// Match center: filters run on the API before pagination.
let live = [], schedule = { up: [], past: [], more: {} }, tab = 'live', schedulePage = 1;
const periods = { up: 'all', past: 'all' }, liveState = state(), scheduleState = state();
function followButton(name, slug) {
  if (!name || name === 'TBD') return '';
  const active = isFollowed(followed, name, slug);
  return `<button type="button" class="follow-team" data-follow="${esc(name)}" data-game="${esc(slug)}" aria-pressed="${active}" aria-label="${active ? 'Не следить за' : 'Следить за'} ${esc(name)}">${active ? '★' : '☆'}</button>`;
}
function matchCard(m, fallback = 'up') {
  matches.set(String(m.id), m);
  const kind = matchKind(m, fallback), playing = kind === 'live', finished = kind === 'past', pending = kind === 'up';
  const hidden = hideScores && !revealed.has(String(m.id)) && (playing || finished);
  const winner = name => !hidden && finished && m.win === name;
  const teamRow = (name, image, score) => `<div class="team-row${winner(name) ? ' winner' : ''}"><button class="tl team-name" data-team="${esc(name)}" data-game="${esc(m.slug)}">${hs(image) ? `<img class="team-logo" src="${hs(image)}" alt="" loading="lazy" width="28" height="28">` : ''}<span>${esc(name)}</span></button>${followButton(name, m.slug)}<span class="team-score">${hidden ? '—' : playing || finished ? esc(finished && !m.win && m.x + m.y === 0 ? '—' : score ?? '—') : '—'}</span></div>`;
  let channel = ''; try { const u = new URL(m.stream); if (/(^|\.)twitch\.tv$/.test(u.hostname)) channel = u.pathname.split('/').filter(Boolean)[0] || ''; } catch {}
  const stateText = playing ? '<b>В эфире</b>' : `<span>${kind === 'canceled' ? 'Отменён' : kind === 'postponed' ? 'Перенесён' : finished ? 'Завершён' : esc(fmt(m.t))}</span>`;
  return `<article class="cd match-card" data-match="${esc(m.id)}" style="--g:${GC[m.slug] || 'var(--mu)'}"><div class="lv"><span class="gm">${esc(m.game || gameName(m.slug))}</span>${stateText}</div><div class="ev">${esc(m.event || 'Турнир уточняется')}</div>${teamRow(m.a, m.aImg, m.x)}${teamRow(m.b, m.bImg, m.y)}<div class="ds">${pending ? esc(until(m.t)) + ' · ' : ''}${finished ? esc(fmt(m.t)) + ' · ' : ''}${m.bo ? 'Bo' + esc(m.bo) : 'Формат уточняется'}</div>${hidden ? `<button class="mo" data-reveal="${esc(m.id)}">Показать счёт</button>` : ''}${playing && channel ? `<button class="bt" data-watch="${esc(channel)}">Смотреть на сайте</button>` : ''}${playing && hs(m.stream) ? `<a class="bt" href="${hs(m.stream)}" target="_blank" rel="noopener noreferrer">Трансляция ↗</a>` : ''}${pending && m.t ? `<button class="mo" data-calendar="${esc(m.id)}">В календарь</button>` : ''}</article>`;
}
function groupedMatches(items, fallback) {
  if (fallback === 'live') return `<div class="gr">${items.map(m => matchCard(m, fallback)).join('')}</div>`;
  const groups = new Map();
  for (const m of items) {
    const date = m.t && Number.isFinite(Date.parse(m.t)) ? new Date(m.t).toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Дата уточняется';
    if (!groups.has(date)) groups.set(date, []); groups.get(date).push(m);
  }
  return [...groups].map(([date, group]) => `<div class="match-day"><h3>${esc(date)}</h3><div class="gr">${group.map(m => matchCard(m, fallback)).join('')}</div></div>`).join('');
}
function renderMatches() {
  chips('#mt', [['live', 'В эфире'], ['up', 'Ближайшие'], ['past', 'Результаты']], tab, next => { if (tab === next) return; tab = next; renderMatches(); if (tab !== 'live') loadSchedule(true); });
  const periodOptions = tab === 'past' ? [['all', 'Последние'], ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', '7 дней']] : [['all', 'Все даты'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['week', '7 дней']];
  $('#match-days').hidden = tab === 'live';
  chips('#match-days', periodOptions, periods[tab] || 'all', next => { periods[tab] = next; loadSchedule(true); });
  const s = tab === 'live' ? liveState : scheduleState;
  $('#match-status').innerHTML = statusMarkup(s, tab === 'live' ? 'live' : 'schedule', s.partial ? 'Часть матчей не удалось загрузить.' : '') + (s.partial && !s.loading && !s.error ? retry('live') : '');
  const items = filterMatches(tab === 'live' ? live : schedule[tab], { game, query: $('#match-search').value, ...(tab === 'live' ? {} : dateRange(periods[tab], tab)) });
  $('#mg').classList.remove('gr');
  replaceMarkup($('#mg'), items.length ? groupedMatches(items, tab) : s.loading ? loading('Загружаем матчи…') : s.error ? stateBox('Не удалось загрузить матчи', 'Попробуйте обновить данные ещё раз.') : stateBox(tab === 'live' ? 'Сейчас нет подходящих матчей в эфире' : 'Матчи не найдены', $('#match-search').value.trim() ? 'Поиск работает по загруженным матчам. Измените запрос или загрузите следующую страницу.' : 'Выберите другую дату или игру.', tab === 'live' ? '<button class="mo" data-upcoming>Посмотреть ближайшие</button>' : ''));
  $('#match-more').innerHTML = tab !== 'live' && schedule.more?.[tab] ? `<button class="mo" data-more-matches ${s.loading ? 'disabled' : ''}>${s.loading ? 'Загрузка…' : 'Показать ещё матчи'}</button>` : '';
}
async function loadLive(reset = false) {
  const request = gates.begin('live'); if (reset) { live = []; Object.assign(liveState, state(), { partial: false }); }
  liveState.loading = true; renderMatches();
  try { const result = await api('/live' + qs({ game, meta: 1 }), request.signal); if (!request.current()) return; const items = Array.isArray(result) ? result : result.items; if (!Array.isArray(items)) throw new Error('Invalid matches'); live = items; liveState.updated = result.updatedAt || new Date().toISOString(); liveState.partial = !!result.partial; liveState.error = false; }
  catch { if (!request.current()) return; liveState.error = true; }
  liveState.loading = false; renderMatches(); renderFavorites();
}
async function loadSchedule(reset = false, append = false) {
  const request = gates.begin('schedule');
  if (reset) { schedulePage = 1; schedule = { up: [], past: [], more: {} }; Object.assign(scheduleState, state()); }
  const page = append ? schedulePage + 1 : 1, activeTab = tab === 'past' ? 'past' : 'up';
  const range = dateRange(periods[activeTab], activeTab);
  scheduleState.loading = true; renderMatches();
  try {
    const result = await api('/schedule' + qs({ game, page, ...range }), request.signal); if (!request.current()) return;
    if (!Array.isArray(result.up) || !Array.isArray(result.past)) throw new Error('Invalid schedule');
    schedule = { up: uniqueMatches([...(append ? schedule.up : []), ...result.up]), past: uniqueMatches([...(append ? schedule.past : []), ...result.past]), more: result.more || {} };
    schedulePage = page; scheduleState.updated = result.updatedAt || new Date().toISOString(); scheduleState.error = false;
  } catch { if (!request.current()) return; scheduleState.error = true; }
  scheduleState.loading = false; renderMatches();
}
$('#match-search').oninput = renderMatches;

// Each followed team gets its own schedule, independent of the global page limit.
let favoriteMatches = [];
const favoriteState = state();
function renderFavorites() {
  $('#myw').hidden = false;
  $('#followed-teams').innerHTML = followed.map(t => `<span class="followed-chip"><button class="mo" data-team="${esc(t.name)}" data-game="${esc(t.game)}">${esc(t.name)}${t.game ? ' · ' + esc(gameName(t.game)) : ''}</button><button class="follow-team" data-follow="${esc(t.name)}" data-game="${esc(t.game)}" aria-label="Не следить за ${esc(t.name)}">×</button></span>`).join('');
  $('#my-status').innerHTML = followed.length ? statusMarkup(favoriteState, 'favorites') : '';
  if (!followed.length) { $('#mym').innerHTML = stateBox('Ваши команды — всегда рядом', 'Нажмите ☆ рядом с командой в матче или найдите её через поиск игроков. Здесь появится её расписание.', '<a class="bt" href="#matches">Выбрать в матчах</a><a class="mo" href="#players">Найти команду</a>'); return; }
  const combined = uniqueMatches([...favoriteMatches, ...live.filter(m => isFollowed(followed, m.a, m.slug) || isFollowed(followed, m.b, m.slug))]);
  const visible = filterMatches(combined.filter(m => isFollowed(followed, m.a, m.slug) || isFollowed(followed, m.b, m.slug)), { game }).filter(m => !['past', 'canceled'].includes(matchKind(m))).sort((a, b) => (matchKind(a) === 'live' ? -1 : 0) - (matchKind(b) === 'live' ? -1 : 0) || Date.parse(a.t) - Date.parse(b.t));
  $('#mym').innerHTML = visible.length ? visible.map(m => matchCard(m)).join('') : favoriteState.loading ? loading('Ищем матчи ваших команд…') : stateBox(favoriteState.error ? 'Расписание обновлено не полностью' : 'В выбранной игре пока нет матчей ваших команд', favoriteState.error ? 'Некоторые команды не удалось загрузить. Повторите попытку.' : 'Вы можете выбрать «Все игры», чтобы увидеть больше матчей.');
}
async function loadFavorites() {
  const request = gates.begin('favorites');
  if (!followed.length) { favoriteMatches = []; Object.assign(favoriteState, state()); renderFavorites(); return; }
  favoriteState.loading = true; renderFavorites();
  const teams = [...followed], results = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, teams.length) }, async () => {
    while (cursor < teams.length && request.current()) {
      const team = teams[cursor++];
      try { const result = await api('/team' + qs({ name: team.name, game: team.game }), request.signal); results.push({ ok: true, partial: result.unavailable?.some(key => key === 'live' || key === 'up') || false, items: [...(result.live || []), ...(result.up || [])] }); }
      catch { results.push({ ok: false, items: [] }); }
    }
  }));
  if (!request.current()) return;
  const ok = results.filter(r => r.ok);
  if (ok.length) { favoriteMatches = uniqueMatches([...(results.some(r => !r.ok || r.partial) ? favoriteMatches : []), ...results.flatMap(r => r.items)]); favoriteState.updated = new Date().toISOString(); }
  favoriteState.error = results.some(r => !r.ok || r.partial); favoriteState.loading = false; renderFavorites();
}
function changeFollow(name, slug) {
  followed = toggleTeam(followed, name, slug); save('ft', followed);
  toast(isFollowed(followed, name, slug) ? `${name} — в избранном` : `${name} — подписка убрана`);
  renderMatches(); renderDetail(); loadFavorites();
}

let tournaments = [];
const tourState = state();
function renderTournaments() {
  $('#tour-status').innerHTML = statusMarkup(tourState, 'tournaments', tourState.partial ? 'Часть турниров не загрузилась.' : '') + (tourState.partial && !tourState.loading && !tourState.error ? retry('tournaments') : '');
  const selected = tournaments.filter(t => game === 'all' || t.slug === game), groups = [...new Set(selected.map(t => t.game))];
  $('#trg').innerHTML = groups.length ? groups.map(label => `<h3 class="sb">${esc(label)}</h3><div class="gr">${selected.filter(t => t.game === label).map(t => `<button class="cd pc" style="--g:${GC[t.slug] || 'var(--mu)'}" data-tournament="${esc(t.id)}"><span class="ds">${t.s === 'run' ? 'Идёт сейчас' : 'Скоро'}</span><b>${esc(t.name)}</b><span class="ds">${esc(fmt(t.b))}${t.pp ? ' · ' + esc(t.pp) : ''}</span></button>`).join('')}</div>`).join('') : tourState.loading ? loading('Загружаем турниры…') : stateBox(tourState.error ? 'Турниры временно недоступны' : 'В этой игре пока нет турниров', 'Попробуйте выбрать другую игру.');
}
async function loadTournaments(reset = false) {
  const request = gates.begin('tournaments'); if (reset) { tournaments = []; Object.assign(tourState, state(), { partial: false }); }
  tourState.loading = true; renderTournaments();
  try {
    const data = await api('/tournaments' + qs({ game, meta: 1 }), request.signal); if (!request.current()) return;
    const items = Array.isArray(data) ? data : data.items; if (!Array.isArray(items)) throw new Error('Invalid tournaments');
    tournaments = items; tourState.partial = !!data.partial; tourState.updated = data.updatedAt || new Date().toISOString(); tourState.error = false;
  } catch { if (!request.current()) return; tourState.error = true; }
  tourState.loading = false; renderTournaments();
}

// Request gates prevent results from an old game or query replacing newer ones.
let players = [], playerPage = 1, playerMore = false, searchQuery = '', searchResult = null, searchAll = false, searchTimer;
const playerState = state(), favPlayers = () => arrayStore('fav');
function playerCard(p) { return `<button class="cd pc" style="--g:${GC[p.game] || 'var(--mu)'}" data-player="${esc(p.name)}" data-game="${esc(p.game)}" data-roster="${esc(p.team)}"><b>${esc(p.name)}</b><span class="ds">${esc(p.gn || gameName(p.game))}${p.team ? ' · ' + esc(p.team) : ''}${p.role ? ' · ' + esc(role(p.role)) : ''}</span></button>`; }
function renderPlayers() {
  const searching = searchQuery.length > 1;
  $('#sh').textContent = searching ? `Поиск ${searchAll || game === 'all' ? 'во всех играх' : 'в ' + gameName(game)}` : 'Найдите игрока или команду, чтобы открыть состав и расписание.';
  $('#fv').innerHTML = favPlayers().length ? `<div class="ch"><span class="ds">Избранные игроки:</span>${favPlayers().map(p => `<button data-player="${esc(p.n)}" data-game="${esc(p.g)}">★ ${esc(p.n)}</button>`).join('')}</div>` : '';
  const items = searching ? searchResult?.items || [] : players, pending = searching ? !searchResult : playerState.loading, error = searching ? searchResult?.error : playerState.error;
  $('#pg').innerHTML = items.length ? items.map(playerCard).join('') : pending ? loading(searching ? 'Ищем игроков…' : 'Загружаем игроков…') : error ? stateBox('Не удалось загрузить игроков', 'Попробуйте ещё раз.', retry(searching ? 'search' : 'players')) : stateBox('Игроки не найдены', 'Попробуйте только ник или название команды.', searching && !searchAll && game !== 'all' ? '<button class="mo" data-search-all>Искать во всех играх</button>' : '');
  $('#pm').innerHTML = !searching && playerMore ? `<button class="mo" data-more-players ${playerState.loading ? 'disabled' : ''}>${playerState.loading ? 'Загрузка…' : 'Показать ещё игроков'}</button>` : '';
  if (error && items.length) $('#pm').innerHTML += `<p class="ds">Не удалось обновить список. ${retry('players')}</p>`;
}
async function loadPlayers(reset = false, append = false) {
  const request = gates.begin('players'); if (reset) { players = []; playerPage = 1; playerMore = false; Object.assign(playerState, state()); }
  const page = append ? playerPage + 1 : 1; playerState.loading = true; renderPlayers();
  try {
    const data = await api('/players' + qs({ game, page }), request.signal); if (!request.current()) return;
    if (!Array.isArray(data.items)) throw new Error('Invalid players');
    players = [...new Map([...(append ? players : []), ...data.items].map(p => [p.game + '|' + p.name, p])).values()]; playerMore = !!data.more; playerPage = page; playerState.error = false;
  } catch { if (!request.current()) return; playerState.error = true; }
  playerState.loading = false; renderPlayers();
}
async function searchPlayers(query, all = false) {
  const request = gates.begin('search'); searchQuery = query; searchAll = all; searchResult = null;
  if (query.length < 2) { renderPlayers(); return; }
  renderPlayers();
  try { const data = await api('/search' + qs({ q: query, game: all ? 'all' : game }), request.signal); if (!request.current()) return; if (!Array.isArray(data.items)) throw new Error('Invalid search'); searchResult = data; }
  catch { if (!request.current()) return; searchResult = { error: true, items: [] }; }
  renderPlayers();
}
$('#q').oninput = event => { clearTimeout(searchTimer); gates.cancel('search'); searchQuery = event.target.value.trim(); searchResult = null; renderPlayers(); searchTimer = setTimeout(() => searchPlayers(searchQuery), 350); };
$('#q').onkeydown = event => { if (event.key === 'Enter') { clearTimeout(searchTimer); searchPlayers(event.target.value.trim()); } };

const initialTitle = document.title, initialDescription = $('meta[name="description"]').content;
function pageMeta(name, description = initialDescription) { document.title = name ? `${name} | Esports Pulse` : initialTitle; $('meta[name="description"]').content = description; $('meta[property="og:title"]').content = document.title; $('meta[property="og:description"]').content = description; }
function showDialog(html, label = 'Подробности') { const d = $('#dl'); d.setAttribute('aria-label', label); $('#pr').innerHTML = html; if (!d.open) d.showModal(); }
function entityPath(type, id, params = {}) { const query = qs(params); return `/${type}/${encodeURIComponent(id)}${query === '?' ? '' : query}`; }
function goEntity(path, label, fromRoute) { if (!fromRoute && location.pathname + location.search !== path) history.pushState(null, '', path); pageMeta(label); }
async function openTeam(name, slug, fromRoute = false) {
  const request = gates.begin('dialog'); currentDetail = null; goEntity(entityPath('team', name, { game: slug }), name, fromRoute); showDialog(loading('Загружаем команду…'), name);
  try { const data = await api('/team' + qs({ name, game: slug }), request.signal); if (!request.current()) return; currentDetail = { type: 'team', data, loadedAt: data.updatedAt || new Date().toISOString(), refresh: () => openTeam(name, slug, true) }; renderDetail(); }
  catch { if (request.current()) showDialog(stateBox('Не удалось открыть команду', 'Команда не найдена или данные временно недоступны.', `<button class="mo" data-team="${esc(name)}" data-game="${esc(slug)}">Повторить</button>`), name); }
}
async function openPlayer(name, slug, roster, fromRoute = false) {
  const request = gates.begin('dialog'); currentDetail = null; goEntity(entityPath('player', name, { game: slug, team: roster }), name, fromRoute); showDialog(loading('Загружаем игрока…'), name);
  try { const data = await api('/player' + qs({ name, game: slug, team: roster }), request.signal); if (!request.current()) return; currentDetail = { type: 'player', data }; renderDetail(); }
  catch { if (request.current()) showDialog(stateBox('Не удалось открыть игрока', 'Игрок не найден или данные временно недоступны.', `<button class="mo" data-player="${esc(name)}" data-game="${esc(slug)}" data-roster="${esc(roster)}">Повторить</button>`), name); }
}
async function openTournament(id, fromRoute = false) {
  const request = gates.begin('dialog'); currentDetail = null;
  const name = tournaments.find(t => String(t.id) === String(id))?.name || 'Турнир';
  goEntity(entityPath('tournament', id), name, fromRoute); showDialog(loading('Загружаем матчи турнира…'), name);
  try { const data = await api('/tournament' + qs({ id }), request.signal); if (!request.current()) return; if (!Array.isArray(data)) throw new Error('Invalid tournament'); currentDetail = { type: 'tournament', data, name, loadedAt: new Date().toISOString(), refresh: () => openTournament(id, true) }; renderDetail(); }
  catch { if (request.current()) showDialog(stateBox('Не удалось загрузить турнир', 'Попробуйте ещё раз.', `<button class="mo" data-tournament="${esc(id)}">Повторить</button>`), name); }
}
const avatar = p => `<div class="av">${hs(p.img) ? `<img src="${hs(p.img)}" data-initial="${esc(p.name?.[0])}" alt="" width="76" height="76">` : esc(p.name?.[0] || '?')}</div>`;
function renderDetail() {
  if (!currentDetail || !$('#dl').open) return;
  const p = currentDetail.data;
  if (currentDetail.type === 'team') {
    pageMeta(p.name, `${p.name}: состав, ближайшие матчи и результаты на Esports Pulse.`);
    $('#pr').innerHTML = `<div class="ph">${avatar(p)}<div><h3>${esc(p.name)}</h3><div class="ds">${esc(p.gameName)}</div></div>${followButton(p.name, p.game)}</div><button class="mo" data-share>Поделиться ссылкой</button>${p.partial ? '<p class="ds">Некоторые данные команды не загрузились.</p>' : ''}<h4 class="sb">Состав</h4><div class="ch">${(p.players || []).map(player => `<button data-player="${esc(player.name)}" data-game="${esc(p.game)}">${esc(player.name)}${player.role ? ' · ' + esc(role(player.role)) : ''}</button>`).join('') || '<span class="ds">Состав пока не указан</span>'}</div>${p.live?.length ? `<h4 class="sb">В эфире</h4><div class="gr">${p.live.map(m => matchCard(m, 'live')).join('')}</div>` : ''}<h4 class="sb">Ближайшие матчи</h4><div class="gr">${(p.up || []).map(m => matchCard(m)).join('') || `<p class="ds">${p.unavailable?.includes('up') ? 'Расписание не удалось загрузить' : 'Нет матчей в расписании'}</p>`}</div><h4 class="sb">Последние результаты</h4><div class="gr">${(p.past || []).map(m => matchCard(m, 'past')).join('') || '<p class="ds">Нет данных</p>'}</div>`;
  } else if (currentDetail.type === 'player') {
    pageMeta(p.name, `${p.name}: команда, роль и последние матчи на Esports Pulse.`);
    const favorite = favPlayers().some(x => x.n === p.name && x.g === p.game);
    $('#pr').innerHTML = `<div class="ph">${avatar(p)}<div><h3>${esc(p.name)}</h3><div class="ds">${esc(p.real)} · ${esc(p.gameName)}</div>${p.team ? `<button class="tl" data-team="${esc(p.team)}" data-game="${esc(p.game)}">${esc(p.team)}</button>` : '<span class="ds">Без команды</span>'}<div class="ds">Роль: ${esc(role(p.role))}</div></div><button class="fv" id="favorite-player" aria-pressed="${favorite}" aria-label="${favorite ? 'Убрать игрока из избранного' : 'Добавить игрока в избранное'}">${favorite ? '★' : '☆'}</button></div><div class="toolbar"><button class="mo" id="compare-player">Добавить к сравнению</button><button class="mo" data-share>Поделиться ссылкой</button></div>${p.stats?.length ? `<div class="sg">${p.stats.map(row => `<div><b>${esc(row[1])}</b><span>${esc(row[0])}</span></div>`).join('')}</div><p class="ds">Статистика источника; период выборки не указан.</p>` : '<p class="ds">Статистика пока недоступна.</p>'}<h4 class="sb">Последние матчи</h4>${p.history?.length ? `<div class="tw"><table><caption class="sr-only">Последние матчи ${esc(p.name)}</caption><thead><tr><th scope="col">Дата</th><th scope="col">Соперник</th><th scope="col">Турнир</th><th scope="col">Счёт</th><th scope="col">Итог</th></tr></thead><tbody>${p.history.map(m => `<tr><td>${esc(fmt(m.d))}</td><td>${esc(m.o)}</td><td>${esc(m.e)}</td><td>${hideScores ? 'Скрыт' : esc(m.sc === '0:0' ? '—' : m.sc)}</td><td class="${hideScores || m.w == null ? '' : m.w ? 'W' : 'L'}">${hideScores ? 'Скрыт' : m.w == null ? '—' : m.w ? 'Победа' : 'Поражение'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ds">История матчей пока недоступна.</p>'}<p class="ds">Источники: PandaScore${hs(p.lp) ? `, <a href="${hs(p.lp)}" target="_blank" rel="noopener noreferrer">Liquipedia</a>` : ''}</p>`;
    $('#favorite-player').onclick = () => { const items = favPlayers(); save('fav', favorite ? items.filter(x => !(x.n === p.name && x.g === p.game)) : [...items, { n: p.name, g: p.game }]); renderDetail(); renderPlayers(); };
    $('#compare-player').onclick = () => addComparison(p);
  } else if (currentDetail.type === 'tournament') {
    $('#pr').innerHTML = `<h3>${esc(currentDetail.name)}</h3><button class="mo" data-share>Поделиться ссылкой</button><div class="gr">${p.map(m => matchCard(m)).join('') || '<p class="ds">Матчей пока нет</p>'}</div>`;
  }
  if (currentDetail?.loadedAt) $('#pr').insertAdjacentHTML('afterbegin', `<div class="status-line"><span>Загружено в ${clockTime(currentDetail.loadedAt)}. Счёт в карточке обновляется вручную.</span><button class="mo" data-refresh-detail>Обновить</button></div>`);
}
let comparison = [];
function addComparison(player) {
  if (comparison.some(p => p.name === player.name && p.game === player.game)) { toast('Этот игрок уже выбран.'); return; }
  if (comparison.length && comparison[0].game !== player.game) { toast('Для сравнения выберите игроков одной игры.'); return; }
  if (comparison.length === 2) { toast('Уберите одного игрока из панели сравнения.'); return; }
  comparison.push(player); renderComparisonTray(); toast(`${player.name} добавлен к сравнению`);
  if (comparison.length === 2) showComparison();
  else { $('#dl').close(); $('#compare-tray [data-pick-player]')?.focus(); }
}
function renderComparisonTray() {
  const tray = $('#compare-tray'); tray.hidden = !comparison.length;
  tray.innerHTML = `<strong>Сравнение · ${esc(gameName(comparison[0]?.game))}</strong>${comparison.map((p, index) => `<span class="compare-slot"><span>${esc(p.name)}</span><button class="follow-team" data-remove-compare="${index}" aria-label="Убрать ${esc(p.name)} из сравнения">×</button></span>`).join('')}<button class="mo" ${comparison.length === 2 ? 'data-compare' : 'data-pick-player'}>${comparison.length === 2 ? 'Сравнить' : 'Выбрать второго игрока'}</button><button class="mo" data-clear-compare>Очистить</button>`;
}
function showComparison() {
  if (comparison.length !== 2) return;
  gates.cancel('dialog'); currentDetail = null;
  const [a, b] = comparison, labels = [...new Set([...(a.stats || []), ...(b.stats || [])].map(row => row[0]))];
  const row = (label, x, y) => `<tr><th scope="row">${esc(label)}</th><td>${esc(x)}</td><td>${esc(y)}</td></tr>`, stat = (p, label) => (p.stats || []).find(r => r[0] === label)?.[1] ?? '—';
  showDialog(`<h3>Сравнение игроков</h3><p class="ds">${esc(gameName(a.game))}. Период статистики не указан источником: значения могут относиться к разным выборкам.</p><div class="tw"><table><caption class="sr-only">${esc(a.name)} и ${esc(b.name)}</caption><thead><tr><th scope="col">Показатель</th><th scope="col">${esc(a.name)}</th><th scope="col">${esc(b.name)}</th></tr></thead><tbody>${row('Команда', a.team || '—', b.team || '—')}${row('Роль', role(a.role), role(b.role))}${labels.map(label => row(label, stat(a, label), stat(b, label))).join('')}</tbody></table></div>`, 'Сравнение игроков');
}

function watch(channel) { gates.cancel('dialog'); currentDetail = null; showDialog(`<iframe title="Трансляция Twitch" src="https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(location.hostname)}&muted=true" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px"></iframe><p class="ds">Если плеер недоступен, используйте ссылку на трансляцию в карточке матча.</p>`, 'Трансляция'); }
function downloadCalendar(match) {
  try { const blob = new Blob([calendarEvent(match)], { type: 'text/calendar;charset=utf-8' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `match-${match.id}.ics`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('Матч сохранён в файл календаря.'); }
  catch { toast('Для этого матча ещё не указано время начала.'); }
}
async function share() {
  try { if (navigator.share) await navigator.share({ title: document.title, url: location.href }); else if (navigator.clipboard) { await navigator.clipboard.writeText(location.href); toast('Ссылка скопирована.'); } else toast('Скопируйте ссылку из адресной строки.'); }
  catch (error) { if (error.name !== 'AbortError') toast('Не удалось скопировать. Ссылка доступна в адресной строке.'); }
}
$('#dx').onclick = () => $('#dl').close();
$('#dl').onclick = event => { if (event.target === $('#dl')) { const r = $('#dl').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#dl').close(); } };
$('#dl').onclose = () => { gates.cancel('dialog'); currentDetail = null; $('#pr').innerHTML = ''; pageMeta(''); if (/^\/(player|team|tournament)\//.test(location.pathname)) history.pushState(null, '', '/'); };
function route() {
  const match = location.pathname.match(/^\/(player|team|tournament)\/([^/]+)\/?$/);
  if (!match) { gates.cancel('dialog'); if ($('#dl').open) $('#dl').close(); return; }
  let id; try { id = decodeURIComponent(match[2]); } catch { showDialog(stateBox('Некорректная ссылка', 'Вернитесь к списку игроков или матчей.')); return; }
  const query = new URLSearchParams(location.search);
  if (match[1] === 'player') openPlayer(id, query.get('game') || '', query.get('team') || '', true);
  else if (match[1] === 'team') openTeam(id, query.get('game') || '', true);
  else openTournament(id, true);
}
addEventListener('popstate', route);

const reloaders = { news: loadNews, live: loadLive, schedule: loadSchedule, favorites: loadFavorites, tournaments: loadTournaments, players: loadPlayers, search: () => searchPlayers(searchQuery, searchAll) };
document.addEventListener('click', event => {
  const button = event.target.closest('button, a'); if (!button) return; const d = button.dataset;
  if (d.retry) reloaders[d.retry]?.();
  else if (d.follow) changeFollow(d.follow, d.game || '');
  else if (d.team) openTeam(d.team, d.game || '');
  else if (d.player) openPlayer(d.player, d.game || '', d.roster || '');
  else if (d.tournament) openTournament(d.tournament);
  else if (d.calendar) downloadCalendar(matches.get(d.calendar));
  else if (d.watch) watch(d.watch);
  else if ('reveal' in d) { revealed.add(d.reveal); renderMatches(); renderFavorites(); renderDetail(); }
  else if ('upcoming' in d) { tab = 'up'; loadSchedule(true); }
  else if ('moreMatches' in d) loadSchedule(false, true);
  else if ('morePlayers' in d) loadPlayers(false, true);
  else if ('searchAll' in d) searchPlayers(searchQuery, true);
  else if ('share' in d) share();
  else if ('refreshDetail' in d) currentDetail?.refresh?.();
  else if ('removeCompare' in d) { comparison.splice(Number(d.removeCompare), 1); renderComparisonTray(); }
  else if ('clearCompare' in d) { comparison = []; renderComparisonTray(); }
  else if ('compare' in d) showComparison();
  else if ('pickPlayer' in d) { $('#dl').close(); $('#q').value = ''; searchPlayers(''); selectGame(comparison[0].game); $('#players').scrollIntoView({ block: 'start' }); $('#q').focus(); }
});
addEventListener('offline', () => { toast('Вы офлайн. Загруженные данные могут быть устаревшими.'); for (const s of [liveState, scheduleState, newsState, tourState, favoriteState]) s.error = true; renderMatches(); renderNews(); renderFavorites(); renderTournaments(); });
addEventListener('online', () => { toast('Соединение восстановлено. Обновляем данные.'); loadLive(); loadSchedule(); loadNews(); loadTournaments(); loadFavorites(); });
addEventListener('visibilitychange', () => { if (document.hidden) clearInterval(heroTimer); else { renderHero(); if (!liveState.updated || Date.now() - Date.parse(liveState.updated) > 30000) loadLive(); } });
setInterval(() => { if (!document.hidden && !liveState.loading && navigator.onLine !== false) loadLive(); }, 30000);
setInterval(() => { if (!document.hidden && navigator.onLine !== false) { if (!scheduleState.loading && schedulePage === 1) loadSchedule(); if (!favoriteState.loading) loadFavorites(); } }, 300000);
renderGames(); renderComparisonTray(); loadNews(); loadLive(); loadSchedule(); loadTournaments(); loadPlayers(); loadFavorites(); route();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
// Optional public Cloudflare Web Analytics beacon token.
const CF_TOKEN = '';
if (CF_TOKEN) { const script = document.createElement('script'); script.defer = true; script.src = 'https://static.cloudflareinsights.com/beacon.min.js'; script.dataset.cfBeacon = JSON.stringify({ token: CF_TOKEN }); document.head.append(script); }
