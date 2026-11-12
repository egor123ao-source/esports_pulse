import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
const env = { PANDASCORE_TOKEN: 'test-token' };
const context = { waitUntil() {} };
const json = (data, headers = {}) => Response.json(data, { headers });
const request = path => new Request('https://api.example.test' + path);
const fixture = (id = 1, slug = 'cs-go', status = 'running') => ({
  id, status, videogame: { name: slug === 'cs-go' ? 'Counter-Strike' : 'Dota 2', slug },
  opponents: [
    { opponent: { id: 101, name: 'Team A', image_url: 'https://images.example.test/a.png' } },
    { opponent: { id: 202, name: 'Team B', image_url: 'https://images.example.test/b.png' } },
  ],
  results: [{ team_id: 101, score: 1 }, { team_id: 202, score: 0 }],
  begin_at: '2026-11-11T12:00:00Z', number_of_games: 3,
});
async function setup(t, responder) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.pandascore.co', 'Tests must never send real requests');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(url);
    return responder(url, options, calls.length);
  });
  const worker = (await import(new URL('../worker.js', import.meta.url).href + '?test=' + (++moduleId))).default;
  const fetch = path => worker.fetch(request(path), env, context);
  return { worker, calls, fetch };
}

test('schedule preserves the default contract and adds freshness and pagination metadata', async t => {
  const { fetch, calls } = await setup(t, () => json([]));
  const response = await fetch('/schedule');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.up, []);
  assert.deepEqual(result.past, []);
  assert.deepEqual(result.more, { up: false, past: false });
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
  assert.deepEqual(calls.map(u => u.pathname).sort(), ['/matches/past', '/matches/upcoming']);
  for (const url of calls) {
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('per_page'), '24');
    assert.equal(url.searchParams.has('range[begin_at]'), false);
  }
});

test('schedule filters upstream before pagination, forwards UTC range, and normalizes match identity', async t => {
  const { fetch, calls } = await setup(t, url => json([fixture(7, 'cs-go', 'finished')], {
    'X-Total': url.pathname.endsWith('/upcoming') ? '49' : '48',
  }));
  const query = new URLSearchParams({ game: 'csgo', page: '2', from: '2026-11-11T05:00:00+05:00', to: '2026-11-12T05:00:00+05:00' });
  const result = await (await fetch('/schedule?' + query)).json();
  assert.deepEqual(result.more, { up: true, past: false });
  for (const url of calls) {
    assert.ok(url.pathname.startsWith('/csgo/matches/'));
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('per_page'), '24');
    assert.equal(url.searchParams.get('range[begin_at]'), '2026-11-11T00:00:00.000Z,2026-11-12T00:00:00.000Z');
  }
  assert.equal(result.up[0].status, 'finished');
  assert.equal(result.up[0].slug, 'csgo');
  assert.equal(result.up[0].aId, 101);
  assert.equal(result.up[0].bId, 202);
  assert.equal(result.up[0].aImg, 'https://images.example.test/a.png');
  assert.equal(result.up[0].bImg, 'https://images.example.test/b.png');
});

test('schedule uses upstream Link headers instead of assuming a full page always has another page', async t => {
  const { fetch } = await setup(t, url => json(Array.from({ length: 24 }, (_, id) => fixture(id)), {
    Link: url.pathname.endsWith('/upcoming')
      ? '<https://api.pandascore.co/matches/upcoming?page=2>; rel="next"'
      : '<https://api.pandascore.co/matches/past?page=1>; rel="first"',
  }));
  assert.deepEqual((await (await fetch('/schedule')).json()).more, { up: true, past: false });
});

test('invalid filters and ranges return 400 without upstream requests', async t => {
  const { fetch, calls } = await setup(t, () => assert.fail('Invalid input must not request upstream'));
  for (const path of [
    '/schedule?page=0', '/schedule?page=-1', '/schedule?page=1.5', '/schedule?page=oops',
    '/schedule?game=unknown', '/schedule?game=csgo,dota2', '/live?game=unknown', '/tournaments?game=unknown',
    '/schedule?from=2026-11-11', '/schedule?to=2026-11-12',
    '/schedule?from=2026-11-12&to=2026-11-11',
    '/schedule?from=invalid&to=2026-11-11', '/schedule?from=2026-02-30&to=2026-03-02',
  ]) {
    assert.equal((await fetch(path)).status, 400, path);
  }
  assert.equal(calls.length, 0);
});

test('live filters upstream by game while keeping the legacy array and a cache per game', async t => {
  const { fetch, calls } = await setup(t, url => json(url.pathname.startsWith('/csgo/') ? [fixture(1)]
    : url.pathname.startsWith('/dota2/') ? [fixture(2, 'dota-2')] : [fixture(1), fixture(2, 'dota-2')]));
  const csgo = await (await fetch('/live?game=csgo')).json();
  const dota = await (await fetch('/live?game=dota2')).json();
  const all = await (await fetch('/live')).json();
  assert.deepEqual(csgo.map(m => m.id), [1]);
  assert.deepEqual(dota.map(m => m.id), [2]);
  assert.equal(all.length, 2);
  assert.equal(csgo[0].status, 'running');
  assert.deepEqual(calls.map(url => url.pathname), ['/csgo/matches/running', '/dota2/matches/running', '/matches/running']);
  assert.ok(calls.every(url => url.searchParams.get('per_page') === '100'));
  await fetch('/live?game=csgo');
  assert.equal(calls.length, 3);
});

test('schedule cache separates games, pages, and date ranges', async t => {
  const { fetch, calls } = await setup(t, () => json([]));
  const paths = ['/schedule?game=csgo', '/schedule?game=dota2', '/schedule?game=csgo&page=2',
    '/schedule?game=csgo&from=2026-11-11&to=2026-11-12'];
  for (const path of paths) assert.equal((await fetch(path)).status, 200);
  assert.equal(calls.length, 8);
  for (const path of paths) await fetch(path);
  assert.equal(calls.length, 8);
});

test('tournaments fetch only selected games and expose partial failure with metadata', async t => {
  const { fetch, calls } = await setup(t, url => url.pathname.endsWith('/running')
    ? json([{ id: 11, name: 'Finals', league: { name: 'League' } }])
    : new Response('Unavailable', { status: 503 }));
  const response = await fetch('/tournaments?game=csgo&meta=1');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.partial, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].slug, 'csgo');
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.pathname.startsWith('/csgo/tournaments/')));
  assert.deepEqual(await (await fetch('/tournaments?game=csgo')).json(), result.items);
  assert.equal(calls.length, 3, 'Metadata and legacy responses reuse successful branches and retry failed ones');
});

test('tournaments accepts multiple selected games and preserves empty successful responses', async t => {
  const { fetch, calls } = await setup(t, () => json([]));
  const result = await (await fetch('/tournaments?game=dota2,csgo,csgo&meta=1')).json();
  assert.equal(calls.length, 4);
  assert.equal(result.partial, false);
  assert.deepEqual(result.items, []);
});

test('complete tournament failure returns 502 and is not cached as a successful empty list', async t => {
  let healthy = false;
  const { fetch, calls } = await setup(t, () => healthy ? json([]) : new Response('Unavailable', { status: 503 }));
  const failed = await fetch('/tournaments?game=csgo&meta=1');
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /unavailable/);
  healthy = true;
  const recovered = await fetch('/tournaments?game=csgo&meta=1');
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).partial, false);
  assert.equal(calls.length, 4);
});

test('concurrent cache misses coalesce and cached metadata keeps the original updatedAt', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, calls } = await setup(t, async () => { await gate; return json([]); });
  const first = fetch('/schedule?game=csgo');
  const second = fetch('/schedule?game=csgo');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'One upcoming request and one past request for both callers');
  release();
  const [a, b] = await Promise.all([first.then(r => r.json()), second.then(r => r.json())]);
  assert.deepEqual(a, b);
  const cached = await (await fetch('/schedule?game=csgo')).json();
  assert.equal(cached.updatedAt, a.updatedAt);
  assert.equal(calls.length, 2);
});

test('failed coalesced requests can retry and never reuse expired data as fresh', async t => {
  let healthy = true, now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { fetch, calls } = await setup(t, () => healthy ? json([fixture()]) : new Response('Unavailable', { status: 503 }));
  assert.equal((await fetch('/schedule')).status, 200);
  now += 301000;
  healthy = false;
  const failed = await Promise.all([fetch('/schedule'), fetch('/schedule')]);
  assert.ok(failed.every(response => response.status === 502));
  assert.equal(calls.length, 4);
  healthy = true;
  assert.equal((await fetch('/schedule')).status, 200);
  assert.equal(calls.length, 6);
});

test('tournament match detail retains canceled and postponed statuses and missing opponent data', async t => {
  const { fetch } = await setup(t, () => json([
    { id: 1, status: 'canceled', opponents: [] },
    { id: 2, status: 'postponed', opponents: [] },
  ]));
  const result = await (await fetch('/tournament?id=5')).json();
  assert.deepEqual(result.map(m => m.status), ['canceled', 'postponed']);
  assert.equal(result[0].aId, null);
  assert.equal(result[0].bImg, null);
  assert.equal(result[0].a, 'TBD');
});

test('upstream timeout aborts a stalled response body and allows a later retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stalled = true;
  const { fetch } = await setup(t, (url, options) => stalled ? {
    ok: true,
    headers: new Headers(),
    json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  } : json([]));
  const pending = fetch('/live');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /timeout/);
  stalled = false;
  assert.equal((await fetch('/live')).status, 200);
});

test('team live matches are requested by team ID independently of the global live and schedule lists', async t => {
  const { fetch, calls } = await setup(t, url => {
    if (url.pathname === '/csgo/teams') return json([{ id: 101, name: 'Team A', current_videogame: { slug: 'cs-go' }, players: [] }]);
    assert.equal(url.pathname, '/teams/101/matches');
    const status = url.searchParams.get('filter[status]');
    return json([fixture({ running: 10, not_started: 11, finished: 12 }[status], 'cs-go', status)]);
  });
  const response = await fetch('/team?name=Team%20A&game=csgo');
  assert.equal(response.status, 200);
  const team = await response.json();
  assert.equal(team.id, 101);
  assert.deepEqual(team.live.map(m => m.id), [10]);
  assert.deepEqual(team.up.map(m => m.id), [11]);
  assert.deepEqual(team.past.map(m => m.id), [12]);
  assert.equal(team.live[0].status, 'running');
  assert.equal(team.partial, false);
  assert.deepEqual(team.unavailable, []);
  assert.ok(Number.isFinite(Date.parse(team.updatedAt)));
  assert.equal(calls.length, 4);
});

test('team refreshes live matches after 30 seconds while reusing the roster, upcoming matches, and past results', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { fetch, calls } = await setup(t, url => url.pathname === '/mlbb/teams'
    ? json([{ id: 101, name: 'Team A', current_videogame: { slug: 'mlbb' }, players: [] }]) : json([]));
  assert.equal((await fetch('/team?name=Team%20A&game=mlbb')).status, 200);
  assert.equal(calls.length, 4);
  now += 31000;
  assert.equal((await fetch('/team?name=Team%20A&game=mlbb')).status, 200);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1).searchParams.get('filter[status]'), 'running');
});

test('team marks partial match failures and returns 502 when every match section fails', async t => {
  let totalFailure = false;
  const { fetch } = await setup(t, url => {
    if (url.pathname === '/teams') return json([{ id: url.searchParams.get('search[name]') === 'Team A' ? 101 : 102, name: url.searchParams.get('search[name]'), players: [] }]);
    return totalFailure || url.searchParams.get('filter[status]') === 'running'
      ? new Response('Unavailable', { status: 503 }) : json([]);
  });
  const team = await (await fetch('/team?name=Team%20A')).json();
  assert.equal(team.partial, true);
  assert.deepEqual(team.unavailable, ['live']);
  assert.deepEqual(team.live, []);
  totalFailure = true;
  const failed = await fetch('/team?name=Team%20B');
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /team matches unavailable/);
});

test('live follows X-Total across pages and preserves the legacy array response', async t => {
  const { fetch, calls } = await setup(t, url => {
    const page = Number(url.searchParams.get('page'));
    return json(page === 1 ? Array.from({ length: 100 }, (_, id) => fixture(id)) : [fixture(100)], { 'X-Total': '101' });
  });
  const response = await fetch('/live');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, 101);
  assert.equal(response.headers.get('X-Data-Partial'), 'false');
  assert.ok(Number.isFinite(Date.parse(response.headers.get('X-Data-Updated-At'))));
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-Data-Partial/);
  assert.deepEqual(calls.map(url => url.searchParams.get('page')), ['1', '2']);
});

test('game-specific live follows Link pagination and removes duplicates between pages', async t => {
  const { fetch, calls } = await setup(t, url => {
    assert.equal(url.pathname, '/valorant/matches/running');
    return url.searchParams.get('page') === '1'
      ? json([fixture(1, 'valorant'), fixture(2, 'valorant')], { Link: '<https://api.pandascore.co/valorant/matches/running?page=2>; rel="next"' })
      : json([fixture(2, 'valorant'), fixture(3, 'valorant')], { Link: '<https://api.pandascore.co/valorant/matches/running?page=1>; rel="prev"' });
  });
  const result = await (await fetch('/live?game=valorant&meta=1')).json();
  assert.deepEqual(result.items.map(match => match.id), [1, 2, 3]);
  assert.equal(result.partial, false);
  assert.equal(calls.length, 2);
});

test('live reports partial data explicitly when the safe pagination limit is reached', async t => {
  const { fetch, calls } = await setup(t, url => {
    const page = Number(url.searchParams.get('page'));
    return json(Array.from({ length: 100 }, (_, id) => fixture((page - 1) * 100 + id)), { 'X-Total': '501' });
  });
  const response = await fetch('/live?meta=1');
  const result = await response.json();
  assert.equal(result.items.length, 500);
  assert.equal(result.partial, true);
  assert.equal(response.headers.get('X-Data-Partial'), 'true');
  assert.equal(calls.length, 5);
});

test('live retries a failed later page immediately while reusing successful pages', async t => {
  let healthy = false;
  const { fetch, calls } = await setup(t, url => url.searchParams.get('page') === '1'
    ? json([fixture(1)], { Link: '<https://api.pandascore.co/matches/running?page=2>; rel="next"' })
    : healthy ? json([fixture(2)]) : new Response('Unavailable', { status: 503 }));
  const partial = await (await fetch('/live?meta=1')).json();
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.items.map(match => match.id), [1]);
  healthy = true;
  const complete = await (await fetch('/live?meta=1')).json();
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.items.map(match => match.id), [1, 2]);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).searchParams.get('page'), '2');
});

test('tournaments retry only the failed branch immediately after a partial response', async t => {
  let healthy = false;
  const { fetch, calls } = await setup(t, url => url.pathname.endsWith('/running') || healthy
    ? json([{ id: url.pathname.endsWith('/running') ? 1 : 2 }]) : new Response('Unavailable', { status: 503 }));
  const partial = await (await fetch('/tournaments?game=csgo&meta=1')).json();
  assert.equal(partial.partial, true);
  healthy = true;
  const complete = await (await fetch('/tournaments?game=csgo&meta=1')).json();
  assert.equal(complete.partial, false);
  assert.equal(complete.items.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).pathname, '/csgo/tournaments/upcoming');
  await fetch('/tournaments?game=csgo&meta=1');
  assert.equal(calls.length, 3);
});

test('team retries only the failed section immediately after a partial response', async t => {
  let healthy = false;
  const { fetch, calls } = await setup(t, url => {
    if (url.pathname === '/teams') return json([{ id: 101, name: 'Team A', players: [] }]);
    return url.searchParams.get('filter[status]') !== 'running' || healthy
      ? json([]) : new Response('Unavailable', { status: 503 });
  });
  const partial = await (await fetch('/team?name=Team%20A')).json();
  assert.equal(partial.partial, true);
  healthy = true;
  const complete = await (await fetch('/team?name=Team%20A')).json();
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.unavailable, []);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1).searchParams.get('filter[status]'), 'running');
});

test('tournament aggregates never extend the expiry of reused branch data', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { fetch, calls } = await setup(t, () => json([]));
  await fetch('/tournaments?game=csgo&meta=1');
  assert.equal(calls.length, 2);
  now += 599000;
  await fetch('/tournaments?game=csgo,dota2&meta=1');
  assert.equal(calls.length, 4, 'Only the new Dota 2 branches are fetched');
  now += 2000;
  await fetch('/tournaments?game=csgo,dota2&meta=1');
  assert.equal(calls.length, 6, 'Expired CS2 branches refresh even though the combination was requested recently');
  assert.ok(calls.slice(-2).every(url => url.pathname.startsWith('/csgo/')));
});

test('a recovered live aggregate never extends the expiry of an older successful page', async t => {
  let now = Date.now(), healthy = false;
  t.mock.method(Date, 'now', () => now);
  const { fetch, calls } = await setup(t, url => url.searchParams.get('page') === '1'
    ? json([fixture(1)], { Link: '<https://api.pandascore.co/matches/running?page=2>; rel="next"' })
    : healthy ? json([fixture(2)]) : new Response('Unavailable', { status: 503 }));
  await fetch('/live?meta=1');
  now += 29000;
  healthy = true;
  assert.equal((await (await fetch('/live?meta=1')).json()).partial, false);
  assert.equal(calls.length, 3);
  now += 2000;
  await fetch('/live?meta=1');
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).searchParams.get('page'), '1');
});
