// The same public files are used by local preview and the production build.
export const PUBLIC_ASSETS = new Map([
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
