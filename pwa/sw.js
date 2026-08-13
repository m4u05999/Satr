/**
 * سطر — Service Worker للتحكم من الجوال
 *
 * - push فارغ: يوقظ الجهاز فقط، والتطبيق يسحب الظرف المعمّى عبر long-poll
 * - كاش القشرة: index / app.js / crypto.js / styles.css / icon / manifest
 */
// رفع النسخة يُبطل الكاش القديم في `activate` — إلزامي مع أي تغيير في أصول القشرة.
const CACHE_NAME = 'satr-pwa-v12';
const SHELL_ASSETS = [
  './index.html',
  './app.js',
  './crypto.js',
  './styles.css',
  './icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!SHELL_ASSETS.includes(url.pathname.replace(/^\/pwa\//, './'))) return;

  // الشبكة أولاً والكاش احتياط عند الانقطاع.
  // كان `cache-first`: الهاتف يواصل تشغيل نسخة قديمة من `app.js` بعد إصلاحها على
  // سطح المكتب، فيبدو العطل قائماً وقد أُصلح — أهدر ذلك جولة تشخيص كاملة.
  // القناة على الشبكة المحلية والتطبيق يستقصيها أصلاً، فكلفة الشبكة أولاً معدومة.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Promise.reject(new Error('offline'))))
  );
});

self.addEventListener('push', (event) => {
  // إشعار فارغ: لا يحمل محتوى، يوقظ فقط
  event.waitUntil(
    self.registration.showNotification('سطر', {
      body: 'طلب إذن جديد في انتظارك',
      icon: './icon.svg',
      badge: './icon.svg',
      tag: 'satr-permission',
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length) {
        clients[0].focus();
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});
