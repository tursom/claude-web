// Keep all application and authentication traffic online. No user data is cached.
const offline = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#fafaf9"><title>连接不可用 · claude-web</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #fafaf9; color: #1c1c1a; }
main { max-width: 360px; padding: 24px; line-height: 1.7; }
h1 { font-size: 22px; } a { display: inline-block; margin-top: 12px; color: inherit; }
@media(prefers-color-scheme: dark) { body { background: #151514; color: #ededeb; } }
</style></head><body><main><h1>暂时无法连接</h1>
<p>claude-web 需要联网连接服务器。请检查网络连接，恢复后重试。</p>
<a href="">重新连接</a></main></body></html>`;

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    event.request.mode !== 'navigate' ||
    url.origin !== self.location.origin ||
    (url.pathname !== '/' && !url.pathname.startsWith('/s/'))
  )
    return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(offline, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        }),
    ),
  );
});
