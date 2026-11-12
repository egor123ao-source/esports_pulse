import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILES = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['app-core.js', 'text/javascript; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['sw.js', 'text/javascript; charset=utf-8'],
  ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['icon.svg', 'image/svg+xml'],
  ['icon-192.png', 'image/png'],
  ['icon-512.png', 'image/png'],
  ['og.png', 'image/png'],
]);

// Явный список публичных файлов не позволяет случайно отдать конфиги и секреты.
export function publicFileForUrl(rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent((rawUrl || '/').split('?')[0]); }
  catch { return null; }
  if (pathname.includes('\\') || pathname.includes('\0')
    || pathname.split('/').some(part => part === '.' || part === '..')) return null;
  if (pathname === '/' || /^\/(player|team|tournament)\/[^/]+\/?$/.test(pathname)) return 'index.html';
  const filename = pathname.slice(1);
  return pathname.startsWith('/') && PUBLIC_FILES.has(filename) ? filename : null;
}

export function createPreviewServer({ root = PROJECT_ROOT } = {}) {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const filename = publicFileForUrl(request.url);
    if (!filename) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : 'Файл не найден.');
      return;
    }
    try {
      const contents = await readFile(resolve(root, filename));
      response.writeHead(200, {
        'Content-Type': PUBLIC_FILES.get(filename),
        'Content-Length': contents.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : 'Не удалось прочитать файл.');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPreviewServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? 'Порт 4173 уже занят. Остановите предыдущий локальный сервер и повторите запуск.'
      : error.message);
    process.exitCode = 1;
  });
  server.listen(4173, '127.0.0.1', () => console.log('Esports Pulse: http://127.0.0.1:4173'));
}
