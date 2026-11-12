// Сеть в приоритете: офлайн-кэш хранит оболочку, но не подменяет свежие данные API.
const VERSION = 'ep-v2';
const SHELL_CACHE = VERSION;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/app-core.js', '/icon.svg'];
const MAX_RUNTIME_ENTRIES = 60;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE)
    .then(cache => cache.addAll(SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys
      .filter(key => key.startsWith('ep-') && ![SHELL_CACHE, RUNTIME_CACHE].includes(key))
      .map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function remember(request, response) {
  if (!response.ok || response.type === 'opaque') return;
  const copy = response.clone();
  const url = new URL(request.url);
  const isShell = SHELL.includes(url.pathname) && !url.search;
  const cache = await caches.open(isShell ? SHELL_CACHE : RUNTIME_CACHE);
  await cache.put(request, copy);
  if (!isShell) {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_RUNTIME_ENTRIES))
      .map(key => cache.delete(key)));
  }
}

async function offlineResponse(request) {
  const cached = await caches.match(request, { cacheName: RUNTIME_CACHE })
    || await caches.match(request, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  const pathname = new URL(request.url).pathname;
  const isAppPage = pathname === '/' || pathname === '/index.html'
    || /^\/(player|team|tournament)\/[^/]+\/?$/.test(pathname);
  if (request.mode === 'navigate' && isAppPage) {
    const shell = await caches.match('/index.html', { cacheName: SHELL_CACHE });
    if (shell) return shell;
  }
  // Для отсутствующих JS, CSS и изображений HTML возвращать нельзя.
  return new Response('Ресурс недоступен без подключения к сети.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const network = fetch(request);
  event.waitUntil(network.then(response => remember(request, response)).catch(() => {}));
  event.respondWith(network.catch(() => offlineResponse(request)));
});
