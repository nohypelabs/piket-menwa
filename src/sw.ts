/// <reference lib="webworker" />
// Service worker PWA: precache app-shell + cache bukti + web push.
// Dibangun via vite-plugin-pwa (injectManifest): self.__WB_MANIFEST diisi otomatis.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

const PRECACHE = 'precache-v1';
const PAGES = 'pages';
const EVIDENCE = 'evidence';

self.addEventListener('install', (e) => {
  const urls = [...new Set(self.__WB_MANIFEST.map((x) => x.url))];
  e.waitUntil(
    caches
      .open(PRECACHE)
      .then((c) => c.addAll(urls))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => ![PRECACHE, PAGES, EVIDENCE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (cache: string, req: Request, res: Response) => {
  const copy = res.clone();
  caches.open(cache).then((c) => c.put(req, copy));
};

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/uploads/')) {
    // Foto bukti: cache-first, max 100 file / 30 hari (LRU sederhana).
    e.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            put(EVIDENCE, request, res);
            trimCache(EVIDENCE, 100);
            return res;
          }),
      ),
    );
    return;
  }
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          put(PAGES, request, res);
          return res;
        })
        .catch(async (): Promise<Response> => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const index = await caches.match('/index.html');
          if (index) return index;
          return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }),
    );
    return;
  }
  e.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          put(PRECACHE, request, res);
          return res;
        }),
    ),
  );
});

async function trimCache(name: string, max: number) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((k) => c.delete(k)));
  }
}

// ---- web push ----
self.addEventListener('push', (e) => {
  let data: { title?: string; body?: string; url?: string } = {};
  try {
    data = e.data?.json() ?? {};
  } catch {
    data = { body: e.data?.text() ?? '' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'Piket Menwa', {
      body: data.body ?? 'Ada kabar baru.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: data.url ?? '/',
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data as string) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          void w.focus();
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
